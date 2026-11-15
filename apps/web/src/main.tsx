import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyTheme, initialTheme } from '@storyforge/design-tokens';
import '@storyforge/design-tokens/tokens.css';
import { App } from './app';

applyTheme(initialTheme());
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
