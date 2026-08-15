# Katax Core Documentation Website

Documentation site for the Katax ecosystem (`katax-core`, `katax-service-manager`, `katax-cli`), built with Astro and Tailwind CSS. Live at https://www.katax.dev/.

## What's on the site

- Overview and key features (type-safe validation, async validation, comprehensive schemas, transform support, minimal dependencies).
- Installation instructions for all three packages.
- Full API reference for `katax-core` (all schema types), `katax-service-manager` (services, bootstrap), and `katax-cli` (commands, generators).
- Quick examples: basic validation, async validators, type inference, nested schemas.
- Links to GitHub and npm.

## Tech Stack

- **Astro** — static site generator
- **Tailwind CSS** — utility-first CSS framework
- **TypeScript**

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:4321` (Astro default) to view the site locally.

## Contributing

Edit documentation content in `src/pages/index.astro`, global styles in `src/styles/`. Submit a pull request with a short description of the change.

## Links

- Live site: https://www.katax.dev/
- Repository: https://github.com/LOPIN6FARRIER/katax-core-page
