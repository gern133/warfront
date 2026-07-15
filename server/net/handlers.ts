import { WebSocket } from 'ws';
import { ClientMsg, Difficulty, MapType } from '../../shared/protocol';
import {
  CState,
  beginRound,
  broadcastLobby,
  clients,
  cleanName,
  enterGame,
  genCode,
  leaveRoom,
  makeRoom,
  publicRoom,
  resetRoom,
  roomFull,
  rooms,
  send,
} from './rooms';

// Обработка входящего сообщения от клиента
export function handleMessage(ws: WebSocket, st: CState, msg: ClientMsg) {
  switch (msg.type) {
    case 'quick': {
      if (roomFull(publicRoom)) {
        send(ws, { type: 'error', message: 'Комната заполнена (макс. 100 игроков)' });
        return;
      }
      leaveRoom(ws, st);
      st.name = cleanName(msg.name);
      st.room = publicRoom;
      publicRoom.clients.add(ws);
      enterGame(ws, st, publicRoom);
      break;
    }
    case 'create': {
      leaveRoom(ws, st);
      st.name = cleanName(msg.name);
      const diff: Difficulty = ['easy', 'normal', 'hard', 'insane'].includes(msg.difficulty)
        ? msg.difficulty
        : 'normal';
      const map: MapType = 'earth'; // только Земля (рандомная генерация убрана)
      const room = makeRoom(genCode(), diff, map, false);
      room.host = ws;
      room.clients.add(ws);
      st.room = room;
      broadcastLobby(room);
      break;
    }
    case 'joinLobby': {
      const code = String(msg.code || '').trim().toUpperCase();
      const target = rooms.get(code);
      if (!target || target.isPublic) {
        send(ws, { type: 'error', message: 'Лобби с таким кодом не найдено' });
        return;
      }
      if (roomFull(target)) {
        send(ws, { type: 'error', message: 'Комната заполнена (макс. 100 игроков)' });
        return;
      }
      leaveRoom(ws, st);
      st.name = cleanName(msg.name);
      st.room = target;
      target.clients.add(ws);
      if (target.phase === 'lobby') broadcastLobby(target);
      else enterGame(ws, st, target);
      break;
    }
    case 'start': {
      const room = st.room;
      if (!room || room.isPublic || room.phase !== 'lobby' || room.host !== ws) return;
      beginRound(room);
      break;
    }
    case 'spawn': {
      const room = st.room;
      if (!room || room.phase === 'lobby' || st.playerId === null) return;
      if (room.game.trySpawn(st.playerId, msg.cell | 0)) {
        send(ws, { type: 'spawned' });
      }
      break;
    }
    case 'respawn': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId !== null) return;
      // если игрок в комнате один — реванш создаёт новый мир (свежая карта +
      // боты); если игроков несколько, общий мир не трогаем
      if (room.clients.size <= 1) {
        if (room.resetTimer) {
          clearTimeout(room.resetTimer);
          room.resetTimer = null;
        }
        room.game.reset();
        room.game.addBots(room.difficulty);
      }
      // затем игрок выбирает точку высадки вручную
      enterGame(ws, st, room);
      break;
    }
    case 'rematch': {
      // новый раунд после победы: свежая карта + боты, все заново выбирают спавн
      const room = st.room;
      if (!room || room.winnerSent === null) return;
      resetRoom(room);
      break;
    }
    case 'attack': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.launchAttackCell(st.playerId, msg.cell | 0, +msg.ratio);
      break;
    }
    case 'invade': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const ok = room.game.launchInvasion(st.playerId, msg.cell | 0, +msg.ratio);
      if (!ok) send(ws, { type: 'error', message: 'Нет морского пути к этой цели' });
      break;
    }
    case 'recall': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.recallBoat(st.playerId, msg.boatId | 0);
      break;
    }
    case 'build': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const err = room.game.build(st.playerId, msg.bt, msg.cell | 0);
      if (err) send(ws, { type: 'error', message: err });
      break;
    }
    case 'upgrade': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const err = room.game.upgrade(st.playerId, msg.cell | 0);
      if (err) send(ws, { type: 'error', message: err });
      break;
    }
    case 'nuke': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const err = room.game.launchNuke(st.playerId, msg.cell | 0, msg.kind || 'basic');
      if (err) send(ws, { type: 'error', message: err });
      break;
    }
    case 'warship': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const err = room.game.launchWarship(st.playerId, msg.cell | 0);
      if (err) send(ws, { type: 'error', message: err });
      break;
    }
    case 'warshipMove': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.moveWarships(st.playerId, (msg.ids || []).map((n) => n | 0), msg.cell | 0);
      break;
    }
    case 'propose': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const res = room.game.proposeAlliance(st.playerId, msg.cell | 0);
      if (!res) break;
      if (res.auto) { send(ws, { type: 'notice', kind: 'accept', name: res.name }); break; } // бот принял
      if (res.refused) { send(ws, { type: 'notice', kind: 'reject', name: res.name }); break; } // бот отклонил
      // человеку — уведомление с возможностью принять/отклонить
      for (const cws of room.clients) {
        const cst = clients.get(cws);
        if (cst?.playerId !== res.toId) continue;
        cst.proposals.add(st.playerId);
        send(cws, { type: 'proposal', from: st.playerId, name: st.name });
        break;
      }
      break;
    }
    case 'allianceResponse': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const from = msg.from | 0;
      if (!st.proposals.delete(from)) return; // не было такого предложения
      if (msg.accept) room.game.acceptAlliance(st.playerId, from);
      // уведомляем предложившего (принял/отклонил) — если он в комнате
      for (const cws of room.clients) {
        const cst = clients.get(cws);
        if (cst?.playerId !== from) continue;
        send(cws, { type: 'notice', kind: msg.accept ? 'accept' : 'reject', name: room.game.playerName(st.playerId) });
        break;
      }
      break;
    }
    case 'breakAlliance': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.breakAlliance(st.playerId, msg.cell | 0);
      break;
    }
    case 'donate': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const kind = msg.kind === 'troops' ? 'troops' : 'gold';
      const err = room.game.donate(st.playerId, msg.cell | 0, kind, Number(msg.amount) || 0);
      if (err) send(ws, { type: 'error', message: err });
      break;
    }
    case 'setSpeed': {
      const room = st.room;
      if (!room) return;
      // скоростью управляет хост лобби, либо любой в одиночной комнате
      const allowed = room.isPublic ? room.clients.size <= 1 : room.host === ws;
      if (!allowed) return;
      if ([0, 0.5, 1, 2, 3, 10].includes(msg.speed)) room.speed = msg.speed;
      break;
    }
    case 'leave': {
      leaveRoom(ws, st);
      break;
    }
  }
}
