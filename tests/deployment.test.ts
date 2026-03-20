import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('Deployment Configuration', () => {
  it('Dockerfile exists and has multi-stage build', () => {
    const content = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf-8');
    expect(content).toContain('FROM node:22-alpine AS builder');
    expect(content).toContain('FROM node:22-alpine');
    expect(content).toContain('ENTRYPOINT');
    expect(content).toContain('HEALTHCHECK');
    expect(content).toContain('USER app');
  });

  it('docker-compose.yml has all required services', () => {
    const content = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8');
    expect(content).toContain('postgres:');
    expect(content).toContain('bot:');
    expect(content).toContain('mcp:');
    expect(content).toContain('cloudflared:');
    expect(content).toContain('pg_isready');
    expect(content).toContain('restart: unless-stopped');
  });

  it('docker-compose.yml has health checks configured', () => {
    const content = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8');
    expect(content).toContain('healthcheck:');
    expect(content).toContain('pg_isready');
    expect(content).toContain('/health');
  });

  it('backup script exists and is executable', () => {
    const path = resolve(ROOT, 'scripts/backup.sh');
    expect(existsSync(path)).toBe(true);
    const stat = statSync(path);
    // Check executable bit
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('backup script validates DATABASE_URL', () => {
    const content = readFileSync(resolve(ROOT, 'scripts/backup.sh'), 'utf-8');
    expect(content).toContain('DATABASE_URL');
    expect(content).toContain('pg_dump');
    expect(content).toContain('.sql.gz');
    expect(content).toContain('BACKUP_RETENTION_DAYS');
  });

  it('migration 002 adds deleted_at to entities and creates entity_corrections', () => {
    const content = readFileSync(resolve(ROOT, 'src/db/migrations/002_entity_corrections.sql'), 'utf-8');
    expect(content).toContain('deleted_at');
    expect(content).toContain('entity_corrections');
    expect(content).toContain('entity_id');
    expect(content).toContain('user_id');
    expect(content).toContain('operation');
    expect(content).toContain('before_value');
    expect(content).toContain('after_value');
  });

  it('.env.example documents all required variables', () => {
    const content = readFileSync(resolve(ROOT, '.env.example'), 'utf-8');
    expect(content).toContain('DISCORD_TOKEN');
    expect(content).toContain('DATABASE_URL');
    expect(content).toContain('GEMINI_API_KEY');
    expect(content).toContain('MCP_AUTH_TOKEN');
    expect(content).toContain('PG_PASSWORD');
    expect(content).toContain('CF_TUNNEL_TOKEN');
  });
});
