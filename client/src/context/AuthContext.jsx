import React, { createContext, useContext, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRedirectPath } from '../utils/authUtils';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tokenExpiryWarning, setTokenExpiryWarning] = useState(false);
    const navigate = useNavigate();

    const decodeToken = (token) => {
        if (!token) {
            throw new Error('No token provided');
        }

        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid token structure');
            }

            const base64Url = parts[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = atob(base64);
            const decoded = JSON.parse(jsonPayload);

            // Debug log the decoded token
            console.log('Raw decoded token:', decoded);

            // Check if decoded token has required fields
            // Note: The server sends 'id' not '_id'
            if (!decoded || !decoded.id || !decoded.role) {
                console.log('Missing required fields in token:', decoded);
                throw new Error('Invalid token payload');
            }

            // Token already has the correct structure, just return it
            return {
                id: decoded.id,
                role: decoded.role.toLowerCase(),
                exp: decoded.exp
            };
        } catch (error) {
            console.error('Token decode error:', error);
            throw new Error('Invalid token format');
        }
    };

    const isTokenExpiringSoon = (decodedToken) => {
        if (!decodedToken?.exp) return false;
        const expiryTime = decodedToken.exp * 1000;
        const now = Date.now();
        const timeUntilExpiry = expiryTime - now;
        return timeUntilExpiry < 5 * 60 * 1000; // 5 minutes
    };

    const checkTokenExpiration = () => {
        const token = localStorage.getItem('token');
        if (!token) return;

        const decoded = decodeToken(token);
        if (!decoded) {
            logout();
            return;
        }

        const expiryTime = decoded.exp * 1000;
        const now = Date.now();

        if (now >= expiryTime) {
            logout();
            return;
        }

        if (isTokenExpiringSoon(decoded)) {
            setTokenExpiryWarning(true);
        } else {
            setTokenExpiryWarning(false);
        }
    };

    useEffect(() => {
        const token = localStorage.getItem('token');
        const storedUser = localStorage.getItem('user');

        if (token && storedUser) {
            try {
                const decoded = decodeToken(token);
                if (decoded && decoded.exp * 1000 > Date.now()) {
                    // Token is valid, set user from localStorage
                    const parsedUser = JSON.parse(storedUser);
                    setUser(parsedUser);

                    // Check if token is expiring soon
                    if (isTokenExpiringSoon(decoded)) {
                        setTokenExpiryWarning(true);
                    }
                } else {
                    // Token expired, clear everything
                    console.log('Token expired, logging out');
                    logout();
                }
            } catch (error) {
                console.error('Error restoring session:', error);
                logout();
            }
        } else {
            // No token or user data found
            setUser(null);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        const interval = setInterval(checkTokenExpiration, 30000); // Check every 30 seconds
        return () => clearInterval(interval);
    }, []);

    const login = async (email, password, department = null, employeeId = null, adminId = null) => {
        try {
            // Determine the endpoint based on the login type
            let endpoint;
            if (adminId) {
                endpoint = '/api/admin/login';
            } else if (department) {
                endpoint = '/api/login/official';
            } else {
                endpoint = '/api/login/petitioner';
            }

            // Extract email if it's an object
            const emailValue = typeof email === 'object' ? email.email : email;

            const response = await fetch(`http://localhost:5000${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: emailValue,
                    password,
                    ...(department && { department }),
                    ...(employeeId && { employeeId }),
                    ...(adminId && { adminId })
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Login failed');
            }

            // Store token in localStorage
            localStorage.setItem('token', data.token);

            // Store user data in localStorage
            localStorage.setItem('user', JSON.stringify(data.user));

            // Set user in state
            setUser(data.user);
            console.log('Raw decoded token:', data.user);

            // Navigate based on role
            if (data.user.role === 'petitioner') {
                navigate('/petitioner/dashboard');
            } else if (data.user.role === 'official') {
                navigate(getRedirectPath('official', data.user.department));
            } else if (data.user.role === 'admin') {
                navigate('/admin/dashboard');
            }

            return data;
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    };

    const logout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
        setTokenExpiryWarning(false);

        // Navigate based on current user role
        const currentRole = user?.role?.toLowerCase();
        switch (currentRole) {
            case 'petitioner':
                navigate('/login/petitioner');
                break;
            case 'official':
                navigate('/login/official');
                break;
            case 'admin':
                navigate('/login/admin');
                break;
            default:
                navigate('/login');
        }
    };

    const handleApiResponse = async (response) => {
        // Check for token expiration warning
        const token = localStorage.getItem('token');
        if (token) {
            const decoded = decodeToken(token);
            if (decoded && isTokenExpiringSoon(decoded)) {
                setTokenExpiryWarning(true);
            }
        }

        if (!response.ok) {
            let errorMessage = 'An error occurred';
            try {
                const data = await response.json();
                // Handle specific error codes
                switch (data.code) {
                    case 'TOKEN_EXPIRED':
                    case 'TOKEN_INVALID':
                    case 'TOKEN_MISSING':
                    case 'USER_NOT_FOUND':
                        logout();
                        throw new Error('Session expired. Please log in again.');
                    default:
                        errorMessage = data.message || data.error || 'An error occurred';
                }
            } catch (e) {
                // If response is not JSON, use status text
                errorMessage = response.statusText || 'An error occurred';
            }
            throw new Error(errorMessage);
        }

        return response;
    };

    const authenticatedFetch = async (url, options = {}) => {
        const token = localStorage.getItem('token');
        if (!token) {
            logout();
            throw new Error('No authentication token found');
        }

        // Check token expiration before making request
        const decoded = decodeToken(token);
        if (decoded && decoded.exp * 1000 <= Date.now()) {
            logout();
            throw new Error('Session expired. Please log in again.');
        }

        // Ensure URL starts with backend server address
        const baseUrl = 'http://localhost:5000';
        const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;

        const defaultHeaders = {
            'Authorization': `Bearer ${token}`,
        };

        // Don't override Content-Type if FormData is being sent
        if (!(options.body instanceof FormData)) {
            defaultHeaders['Content-Type'] = 'application/json';
        }

        const response = await fetch(fullUrl, {
            ...options,
            headers: {
                ...defaultHeaders,
                ...options.headers
            }
        });

        return handleApiResponse(response);
    };

    if (loading) {
        return <div>Loading...</div>;
    }

    return (
        <AuthContext.Provider value={{
            user,
            loading,
            login,
            logout,
            authenticatedFetch,
            tokenExpiryWarning
        }}>
            {tokenExpiryWarning && (
                <div className="fixed top-0 right-0 m-4 p-4 bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700">
                    <p>Your session will expire soon. Please save your work and log in again.</p>
                </div>
            )}
            {children}
        </AuthContext.Provider>
    );
};

export default AuthProvider; 