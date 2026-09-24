import axios from 'axios';

const API = axios.create({
  baseURL: process.env.REACT_APP_API_URL || (process.env.NODE_ENV === 'production' ? '/api' : 'http://localhost:5000/api'),
});

API.interceptors.request.use((config) => {
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('ricoz_user'));
  } catch (error) {
    localStorage.removeItem('ricoz_user');
  }
  if (user && user.token) {
    config.headers.Authorization = `Bearer ${user.token}`;
  }
  return config;
});

API.interceptors.response.use(
  (response) => response,
  (error) => {
    // Never surface the bearer token: strip it from the serialized request
    // config before the error propagates so console.error(err) can't leak it.
    if (error && error.config && error.config.headers) {
      delete error.config.headers.Authorization;
    }
    return Promise.reject(error);
  }
);

export default API;