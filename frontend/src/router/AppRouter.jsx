import React, { useEffect, useState } from 'react';

export const ROUTES = {
  login: '/',
  student: '/student',
  admin: '/admin',
  proAdmin: '/pro-admin',
  level: '/level',
  topic: '/topic'
};

export default function AppRouter({ children }) {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return <>{typeof children === 'function' ? children(hash.replace(/^#/, '')) : children}</>;
}
