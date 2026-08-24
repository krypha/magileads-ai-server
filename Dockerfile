# Groleads AI Server — image de production.
# Le serveur n'a AUCUNE dépendance npm : on copie juste les sources.

FROM oven/bun:1-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787

# Sources uniquement (voir .dockerignore pour le reste).
COPY package.json ./
COPY src ./src

# L'image oven/bun fournit déjà un utilisateur non-root "bun".
USER bun

EXPOSE 8787

# Dokploy / Docker surveillent l'état du service via /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/server.js"]
