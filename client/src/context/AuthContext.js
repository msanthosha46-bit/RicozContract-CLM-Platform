import React, { createContext, useState } from 'react';
import API from '../services/api';

export const AuthContext = createContext();

const readStoredUser = () => {
  try {
    const savedUser = localStorage.getItem('ricoz_user');
    return savedUser ? JSON.parse(savedUser) : null;
  } catch (error) {
    localStorage.removeItem('ricoz_user');
    return null;
  }
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(readStoredUser);

  const persistUser = (data) => {
    const nextUser = user?.token ? { ...data, token: data.token || user.token } : data;
    setUser(nextUser);
    localStorage.setItem('ricoz_user', JSON.stringify(nextUser));
    return nextUser;
  };

  const login = async (email, password) => {
    const { data } = await API.post('/auth/login', { email, password });
    return persistUser(data);
  };

  const register = async (userData) => {
    const { data } = await API.post('/auth/register', userData);
    return persistUser(data);
  };

  const loginWithGoogle = async (credential) => {
    const { data } = await API.post('/auth/google', { credential });
    return persistUser(data);
  };

  const updateProfile = (data) => {
    if (!user) return null;
    return persistUser({ ...user, ...data, token: user.token });
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('ricoz_user');
  };

  return (
    <AuthContext.Provider value={{ user, login, register, loginWithGoogle, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
};
