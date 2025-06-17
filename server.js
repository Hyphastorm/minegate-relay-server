const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || 'default-secret-change-me';

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Connected servers registry
const connectedServers = new Map();
const serverSessions = new Map();

// Message validation
function validateMessage(message) {
    try {
        const parsed = JSON.parse(message);
        
        // Check required fields
        if (!parsed.type || !parsed.id || !parsed.from || !parsed.to || !parsed.timestamp) {
            return { valid: false, error: 'Missing required fields' };
        }
        
        // Check timestamp (within 5 minutes)
        const messageTime = new Date(parsed.timestamp);
        const now = new Date();
        const timeDiff = Math.abs(now - messageTime) / 1000 / 60; // minutes
        
        if (timeDiff > 5) {
            return { valid: false, error: 'Message timestamp too old' };
        }
        
        // Verify signature if present
        if (parsed.signature) {
            const expectedSignature = signMessage(parsed);
            if (parsed.signature !== expectedSignature) {
                return { valid: false, error: 'Invalid signature' };
            }
        }
        
        return { valid: true, message: parsed };
    } catch (e) {
        return { valid: false, error: 'Invalid JSON' };
    }
}

function signMessage(message) {
    const payload = `${message.type}|${message.timestamp}|${message.from}|${message.to}|${JSON.stringify(message.payload || {})}`;
    return crypto.createHmac('sha256', SHARED_SECRET).update(payload).digest('base64');
}

function createMessage(type, from, to, payload) {
    const message = {
        type,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        from,
        to,
        payload: payload || {}
    };
    message.signature = signMessage(message);
    return message;
}

// WebSocket server
const wss = new WebSocket.Server({
    port: PORT + 1, // WebSocket on PORT + 1
    path: '/minegate/v1/connect'
});

console.log(`🚀 Minegate Relay Server starting...`);
console.log(`📡 WebSocket server: ws://localhost:${PORT + 1}/minegate/v1/connect`);
console.log(`🌐 HTTP server: http://localhost:${PORT}`);

wss.on('connection', (ws, req) => {
    console.log('📥 New WebSocket connection attempt');
    
    // Extract headers
    const auth = req.headers.authorization;
    const serverId = req.headers['x-minegate-server-id'];
    const version = req.headers['x-minegate-version'];
    const capabilities = req.headers['x-minegate-capabilities'];
    
    if (!auth || !serverId) {
        console.log('❌ Connection rejected: Missing auth or server ID');
        ws.close(1008, 'Missing authentication or server ID');
        return;
    }
    
    // Basic token validation (Bearer token)
    const token = auth.replace('Bearer ', '');
    if (token.length < 10) {
        console.log('❌ Connection rejected: Invalid token');
        ws.close(1008, 'Invalid token');
        return;
    }
    
    // Register server
    const serverInfo = {
        serverId,
        version,
        capabilities: capabilities ? capabilities.split(',') : [],
        connected: new Date(),
        lastSeen: new Date(),
        ws
    };
    
    connectedServers.set(serverId, serverInfo);
    console.log(`✅ Server registered: ${serverId} (${capabilities})`);
    
    // Send welcome message with server list
    const serverList = Array.from(connectedServers.values())
        .filter(server => server.serverId !== serverId)
        .map(server => ({
            serverId: server.serverId,
            capabilities: server.capabilities,
            lastSeen: server.lastSeen.toISOString(),
            status: 'online'
        }));
    
    const welcomeMessage = createMessage('server_list', 'relay', serverId, { servers: serverList });
    ws.send(JSON.stringify(welcomeMessage));
    
    // Broadcast new server to all connected servers
    const newServerMessage = createMessage('server_update', 'relay', 'broadcast', {
        action: 'join',
        server: {
            serverId,
            capabilities: serverInfo.capabilities,
            lastSeen: serverInfo.lastSeen.toISOString(),
            status: 'online'
        }
    });
    
    broadcastToAll(newServerMessage, serverId);
    
    ws.on('message', (data) => {
        const validation = validateMessage(data.toString());
        
        if (!validation.valid) {
            console.log(`❌ Invalid message from ${serverId}: ${validation.error}`);
            const errorMessage = createMessage('error', 'relay', serverId, {
                error_code: 'INVALID_MESSAGE',
                error_message: validation.error
            });
            ws.send(JSON.stringify(errorMessage));
            return;
        }
        
        const message = validation.message;
        console.log(`📨 Message from ${serverId}: ${message.type} -> ${message.to}`);
        
        // Update last seen
        if (connectedServers.has(serverId)) {
            connectedServers.get(serverId).lastSeen = new Date();
        }
        
        // Handle different message types
        switch (message.type) {
            case 'heartbeat':
                handleHeartbeat(serverId, message);
                break;
            case 'server_register':
                handleServerRegister(serverId, message);
                break;
            case 'teleport_request':
                handleTeleportRequest(serverId, message);
                break;
            case 'teleport_response':
                handleTeleportResponse(serverId, message);
                break;
            case 'status_update':
                handleStatusUpdate(serverId, message);
                break;
            default:
                console.log(`⚠️  Unknown message type: ${message.type}`);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`📤 Server disconnected: ${serverId} (${code}: ${reason})`);
        connectedServers.delete(serverId);
        
        // Broadcast server departure
        const departMessage = createMessage('server_update', 'relay', 'broadcast', {
            action: 'leave',
            server: { serverId, status: 'offline' }
        });
        broadcastToAll(departMessage);
    });
    
    ws.on('error', (error) => {
        console.log(`❌ WebSocket error for ${serverId}:`, error);
    });
});

function broadcastToAll(message, excludeServerId = null) {
    const messageStr = JSON.stringify(message);
    
    connectedServers.forEach((serverInfo, serverId) => {
        if (serverId !== excludeServerId && serverInfo.ws.readyState === WebSocket.OPEN) {
            serverInfo.ws.send(messageStr);
        }
    });
}

function sendToServer(targetServerId, message) {
    const serverInfo = connectedServers.get(targetServerId);
    if (serverInfo && serverInfo.ws.readyState === WebSocket.OPEN) {
        serverInfo.ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

function handleHeartbeat(serverId, message) {
    // Respond to heartbeat
    const response = createMessage('heartbeat_ack', 'relay', serverId, {
        server_time: new Date().toISOString(),
        connected_servers: connectedServers.size
    });
    
    const serverInfo = connectedServers.get(serverId);
    if (serverInfo) {
        serverInfo.ws.send(JSON.stringify(response));
    }
}

function handleServerRegister(serverId, message) {
    // Update server info with registration details
    const serverInfo = connectedServers.get(serverId);
    if (serverInfo && message.payload) {
        Object.assign(serverInfo, message.payload);
        console.log(`🔄 Server ${serverId} updated registration info`);
    }
}

function handleTeleportRequest(serverId, message) {
    const targetServerId = message.to;
    
    // Forward teleport request to target server
    if (connectedServers.has(targetServerId)) {
        const success = sendToServer(targetServerId, message);
        if (!success) {
            // Send error back to requesting server
            const errorMessage = createMessage('teleport_response', 'relay', serverId, {
                request_id: message.id,
                status: 'failed',
                error_code: 'TARGET_UNAVAILABLE',
                message: `Target server ${targetServerId} is not available`
            });
            sendToServer(serverId, errorMessage);
        }
    } else {
        // Target server not found
        const errorMessage = createMessage('teleport_response', 'relay', serverId, {
            request_id: message.id,
            status: 'failed',
            error_code: 'SERVER_NOT_FOUND',
            message: `Target server ${targetServerId} not found`
        });
        sendToServer(serverId, errorMessage);
    }
}

function handleTeleportResponse(serverId, message) {
    // Forward teleport response to original requesting server
    const originalRequest = message.payload.request_id;
    // In a production system, we'd track the original request source
    // For now, just broadcast to see if any server is waiting for this response
    broadcastToAll(message, serverId);
}

function handleStatusUpdate(serverId, message) {
    if (message.to === 'broadcast') {
        // Broadcast status update to all other servers
        broadcastToAll(message, serverId);
    }
}

// HTTP endpoints for monitoring
app.get('/', (req, res) => {
    res.json({
        service: 'Minegate Relay Server',
        version: '1.0.0',
        status: 'running',
        uptime: process.uptime(),
        connected_servers: connectedServers.size,
        websocket_endpoint: `ws://${req.get('host').replace(PORT, PORT + 1)}/minegate/v1/connect`
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        connected_servers: connectedServers.size,
        memory_usage: process.memoryUsage(),
        uptime: process.uptime()
    });
});

app.get('/servers', (req, res) => {
    const servers = Array.from(connectedServers.values()).map(server => ({
        serverId: server.serverId,
        version: server.version,
        capabilities: server.capabilities,
        connected: server.connected,
        lastSeen: server.lastSeen
    }));
    
    res.json({
        count: servers.length,
        servers
    });
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    wss.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully');
    wss.close(() => {
        process.exit(0);
    });
});

// Start HTTP server
app.listen(PORT, () => {
    console.log(`✅ HTTP server listening on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Server list: http://localhost:${PORT}/servers`);
    console.log(`🌍 Ready to accept connections!`);
});

// Cleanup old disconnected servers periodically
setInterval(() => {
    const now = new Date();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    connectedServers.forEach((serverInfo, serverId) => {
        if (now - serverInfo.lastSeen > timeout) {
            console.log(`🧹 Cleaning up stale server: ${serverId}`);
            connectedServers.delete(serverId);
        }
    });
}, 60000); // Check every minute