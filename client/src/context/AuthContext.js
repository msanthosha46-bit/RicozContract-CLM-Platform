import React, { createContext, useState, useEffect } from 'react';
import API from '../services/api';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const savedUser = localStorage.getItem('ricoz_user');
    return savedUser ? JSON.parse(savedUser) : null;
  });

  const login = async (email, password) => {
    const { data } = await API.post('/auth/login', { email, password });
    setUser(data);
    localStorage.setItem('ricoz_user', JSON.stringify(data));
    return data;
  };

  const register = async (userData) => {
    const { data } = await API.post('/auth/register', userData);
    setUser(data);
    localStorage.setItem('ricoz_user', JSON.stringify(data));
    return data;
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('ricoz_user');
  };

  return (
    <AuthContext.Provider value={{ user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
};