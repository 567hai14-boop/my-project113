Maze PK Retro - Deploy bundle

Contents:
- index.html
- style.css
- main.js
- server.js
- package.json
- netlify.toml

Instructions to deploy to Render (quick):
1. Create a new Web Service on Render and connect your GitHub repo, or upload this project as a repo.
2. In Render service settings, set the Root Directory to the project root (do NOT set to a subfolder unless your server.js is inside it).
3. Set the Start Command to: npm start
4. Ensure the service uses Node 18 and that PORT is not hard-coded (server listens on process.env.PORT).
5. After deploy, copy the service URL (https://your-backend.onrender.com) and update netlify.toml in the static site repo if you host the frontend on Netlify.

Notes about Netlify + Socket.io:
- Netlify proxies may not preserve WebSocket upgrades reliably. main.js uses polling fallback (io({ transports: ['polling','websocket'] })) so connections should work through the Netlify proxy.
- If you can, allow clients to connect directly to the Render domain for best WebSocket support.

Local test:
- Run `npm install` then `npm start` in this folder.
- Open http://localhost:3000 and the static index.html should load and connect to the local socket server.
