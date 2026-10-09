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

// Bad credentials and bad verification codes also answer 401, so the auth
// endpoints are excluded: a failed sign-in attempt must not clear a session or
// bounce the user away from the form they are filling in.
const isAuthEndpoint = (url = '') => /^\/auth\//.test(url);

API.interceptors.response.use(
  (response) => response,
  (error) => {
    // A 401 on a protected endpoint means the stored session is no longer
    // usable (expired, revoked, or otherwise rejected). Clear it and send the
    // user to sign in again instead of leaving a logged-in shell that shows the
    // raw server message in a dead-end error banner.
    if (error?.response?.status === 401 && !isAuthEndpoint(error?.config?.url)) {
      localStorage.removeItem('ricoz_user');
      if (typeof window !== 'undefined' && window.location && window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    // Never surface the bearer token: strip it from the serialized request
    // config before the error propagates so console.error(err) can't leak it.
    if (error && error.config && error.config.headers) {
      delete error.config.headers.Authorization;
    }
    return Promise.reject(error);
  }
);

export default API;