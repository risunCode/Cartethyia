# Deployment and Runtime Settings

Keep deployment, environment, and runtime notes here. The root README stays short.

## Local development

- Backend: Go daemon on `:12800`
- Frontend: Vite dashboard on `:5173`
- Dashboard aux server: internal server on `:8787`

## Environment

- Copy `.env.example` to `.env`
- Keep router/runtime secrets out of the dashboard bundle
- Use the repository root `.env` for shared development settings

## Deployment rule of thumb

- `router/` owns runtime behavior and API ingress
- `dashboard/` owns operator UI only
- `docs/visualize/` is the place for workspace maps and diagrams
