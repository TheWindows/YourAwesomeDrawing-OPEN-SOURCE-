import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = new Map();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`Received ${message.type} from ${message.playerId || 'unknown'}`);

      switch (message.type) {
        case 'join':
          handleJoin(ws, message);
          break;
        case 'offer':
        case 'answer':
        case 'candidate':
          forwardWebRTCMessage(message);
          break;
        case 'chat':
          broadcastChat(message);
          break;
        case 'draw':
        case 'clear':
        case 'fill':
          broadcastDrawing(message);
          break;
        case 'profile':
          updateProfile(message);
          break;
        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (err) {
      console.error('Message handling error:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    cleanupDisconnectedPlayer(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    cleanupDisconnectedPlayer(ws);
  });
});

function handleJoin(ws, data) {
  if (!data.room || !data.playerId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Invalid join message'
    }));
    return;
  }

  let targetRoom = data.room;
  let isHost = false;

  for (const [roomName, roomData] of rooms.entries()) {
    if (roomData.players.size === 1) {
      targetRoom = roomName;
      break;
    }
  }

  if (!rooms.has(targetRoom)) {
    rooms.set(targetRoom, {
      players: new Map(),
      hostId: data.playerId
    });
    isHost = true;
    console.log(`Created room: ${targetRoom}`);
  }

  const room = rooms.get(targetRoom);
  
  ws.room = targetRoom;
  ws.playerId = data.playerId;
  ws.playerName = data.name || `Player${data.playerId.slice(0, 4)}`;
  
  room.players.set(data.playerId, ws);

  ws.send(JSON.stringify({
    type: 'joined',
    room: targetRoom,
    isHost: isHost,
    players: getPlayerList(room)
  }));

  broadcastPlayerList(room);
}

function forwardWebRTCMessage(data) {
  const room = rooms.get(data.room);
  if (!room) {
    console.log(`Room ${data.room} not found`);
    return;
  }

  if (!data.target) {
    room.players.forEach((player, playerId) => {
      if (playerId !== data.playerId && player.readyState === player.OPEN) {
        player.send(JSON.stringify(data));
      }
    });
    return;
  }

  const target = room.players.get(data.target);
  if (!target) {
    console.log(`Target player ${data.target} not found in room ${data.room}`);
    return;
  }

  if (target.readyState === target.OPEN) {
    target.send(JSON.stringify(data));
  } else {
    console.log(`Target player ${data.target} connection not open`);
  }
}

function broadcastChat(data) {
  const room = rooms.get(data.room);
  if (!room) return;

  room.players.forEach(player => {
    if (player.readyState === player.OPEN && player.playerId !== data.playerId) {
      player.send(JSON.stringify({
        type: 'chat',
        message: data.message,
        playerId: data.playerId,
        name: data.name || `Player${data.playerId.slice(0, 4)}`
      }));
    }
  });
}

function broadcastDrawing(data) {
  const room = rooms.get(data.room);
  if (!room) return;

  room.players.forEach(player => {
    if (player.readyState === player.OPEN && player.playerId !== data.playerId) {
      player.send(JSON.stringify(data));
    }
  });
}

function updateProfile(data) {
  const room = rooms.get(data.room);
  if (!room) return;

  const player = room.players.get(data.playerId);
  if (player) {
    player.playerName = data.name;
    broadcastPlayerList(room);
  }
}

function getPlayerList(room) {
  return Array.from(room.players.values()).map(player => ({
    id: player.playerId,
    name: player.playerName
  }));
}

function broadcastPlayerList(room) {
  const playerList = getPlayerList(room);
  
  room.players.forEach(player => {
    if (player.readyState === player.OPEN) {
      player.send(JSON.stringify({
        type: 'players',
        players: playerList
      }));
    }
  });
}

function cleanupDisconnectedPlayer(ws) {
  if (!ws.room || !ws.playerId) return;
  
  const room = rooms.get(ws.room);
  if (!room) return;

  // Remove player
  room.players.delete(ws.playerId);
  console.log(`Player ${ws.playerId} left ${ws.room}`);

  // Handle host migration if needed
  if (room.hostId === ws.playerId && room.players.size > 0) {
    const newHost = room.players.values().next().value;
    room.hostId = newHost.playerId;
    newHost.send(JSON.stringify({
      type: 'host-change'
    }));
    console.log(`New host assigned: ${newHost.playerId}`);
  }

  // Cleanup empty rooms
  if (room.players.size === 0) {
    rooms.delete(ws.room);
    console.log(`Room ${ws.room} deleted (empty)`);
  } else {
    broadcastPlayerList(room);
  }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket running on ws://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down server...');
  wss.clients.forEach(client => client.close());
  wss.close();
  server.close(() => process.exit(0));
});