# Deploy Backend on Render (Free)

1. Push this repo to GitHub (already done).
2. Go to Render dashboard -> New + -> Blueprint.
3. Select this repository (`sample-choerum`).
4. Confirm `render.yaml` is detected.
5. Set environment variables:
   - `ANTHROPIC_API_KEY`
   - `CORS_ORIGINS` (your frontend URL, comma-separated for multiple)
6. Deploy.

After deploy:
- Health check: `https://<your-render-service>.onrender.com/healthz`
- Metrics API: `https://<your-render-service>.onrender.com/api/metrics?keyword=가계부`

For static frontend, set in `index.html` and `public/index.html`:
```html
<meta name="app-api-base-url" content="https://<your-render-service>.onrender.com" />
```
