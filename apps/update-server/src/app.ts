import express, { type Express } from 'express';
import routes from './routes.js';

export function createApp(): Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/', routes);

  return app;
}
