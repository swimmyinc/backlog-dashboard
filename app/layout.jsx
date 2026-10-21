import React from 'react';
import '../styles/globals.scss';

export const metadata = { title: '保守工数ダッシュボード', description: 'クライアント別の保守工数管理' };

export default function RootLayout({ children }) {
  return <html lang="ja"><head>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet" />
  </head><body>{children}</body></html>;
}
