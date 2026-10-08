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

  // Step 1 of Google sign-in: exchange the verified credential for a masked
  // email and a challenge id. Nothing is persisted and no session exists yet —
  // the account is only resolved after the emailed code is verified.
  const beginGoogleOtp = async (credential) => {
    const { data } = await API.post('/auth/google/begin', { credential });
    return data;
  };

  // Step 2: only a verified code may create the session, so persistUser runs
  // here and nowhere else in the Google flow.
  const verifyGoogleOtp = async ({ challengeId, otp }) => {
    const { data } = await API.post('/auth/google/verify-otp', { challengeId, otp });
    return persistUser(data);
  };

  // Step 3: ask for a fresh code for the same challenge.
  const resendGoogleOtp = async (challengeId) => {
    const { data } = await API.post('/auth/google/resend-otp', { challengeId });
    return data;
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
    <AuthContext.Provider
      value={{ user, login, register, beginGoogleOtp, verifyGoogleOtp, resendGoogleOtp, logout, updateProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
};
