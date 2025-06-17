# Minegate Relay Server

A WebSocket relay server for the Minegate decentralized Minecraft network, enabling secure communication between Minecraft servers.

## Features

- WebSocket-based server-to-server communication
- HMAC-SHA256 message authentication
- Automatic server discovery and registration
- Health monitoring and status updates
- Teleportation request routing
- Connection management with cleanup

## Quick Start

```bash
# Local development
npm install
cp .env.example .env
# Edit .env with your settings
npm start

# Docker deployment
docker build -t minegate-relay .
docker run -p 8080:8080 -p 8081:8081 -e SHARED_SECRET=your-secret minegate-relay
```

## API Endpoints

- `GET /` - Service information
- `GET /health` - Health check
- `GET /servers` - Connected servers list

## WebSocket Endpoint

- `ws://hostname:8081/minegate/v1/connect`

## Environment Variables

- `PORT` - HTTP server port (default: 8080)
- `SHARED_SECRET` - HMAC signing key (required)
- `NODE_ENV` - Environment (development/production)

## Message Protocol

See `/references/relay-protocol-specification.md` for detailed protocol documentation.