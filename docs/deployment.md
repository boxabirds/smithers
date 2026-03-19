# Deployment Guide

## Prerequisites

- Hetzner VPS (CX22 or CX32) with Docker and Docker Compose installed
- Discord bot token with MESSAGE_CONTENT privileged intent
- Gemini API key from Google AI Studio
- Cloudflare account (free tier)

## Setup

### 1. Clone and configure

```bash
git clone <repo-url>
cd discord-secretary
cp .env.example .env
# Edit .env with your credentials
```

### 2. Cloudflare Tunnel

1. Go to Cloudflare Zero Trust Dashboard > Networks > Tunnels
2. Create a new tunnel, give it a name (e.g., "discord-secretary")
3. Copy the tunnel token — set it as `CF_TUNNEL_TOKEN` in `.env`
4. Add a public hostname route:
   - Subdomain: `secretary` (or your choice)
   - Domain: your domain
   - Service: `http://mcp:3100`
5. The tunnel routes HTTPS traffic to your MCP server automatically

### 3. Start services

```bash
# Development (no Cloudflare Tunnel)
docker compose up -d

# Production (with Cloudflare Tunnel)
docker compose --profile production up -d
```

### 4. Verify

```bash
# Check all services are healthy
docker compose ps

# Check MCP server health
curl http://localhost:3100/health

# Check via Cloudflare Tunnel (production)
curl https://secretary.yourdomain.com/health
```

## Database Backups

Backups run via the included script:

```bash
# Manual backup
DATABASE_URL=postgres://secretary:${PG_PASSWORD}@localhost:5432/secretary \
  BACKUP_DIR=./backups \
  ./scripts/backup.sh

# Automated daily backup via cron
# Add to crontab: crontab -e
0 3 * * * /path/to/discord-secretary/scripts/backup.sh >> /var/log/secretary-backup.log 2>&1
```

### Restore from backup

```bash
docker compose stop bot mcp
gunzip < backups/secretary_YYYYMMDD_HHMMSS.sql.gz | docker compose exec -T postgres psql -U secretary secretary
docker compose start bot mcp
```

## Costs

| Component | Cost |
|---|---|
| Hetzner CX22/CX32 | €4-8/month |
| Gemini Flash 3 | ~$0.02-0.45/day |
| Cloudflare Tunnel | Free |
| **Total** | **~€5-10/month** |
