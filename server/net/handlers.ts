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
  sendSimSnapshot,
  dropSnapshot,
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
      // песочные настройки доступны только в одиночку — как стало >1 игрока, сбрасываем

      if (target.phase === 'lobby') broadcastLobby(target);
      else { enterGame(ws, st, target); target.game.resendBoatPaths(); } // новый клиент должен увидеть маршруты уже плывущих десантов
      break;
    }
    case 'start': {
      const room = st.room;
      if (!room || room.isPublic || room.phase !== 'lobby' || room.host !== ws) return;
      beginRound(room);
      break;
    }
    case 'lobbySettings': {
      const room = st.room;
      if (!room || room.isPublic || room.phase !== 'lobby' || room.host !== ws) return;
      // Бесконечные деньги/армию можно включать и в онлайне: настройка комнаты
      // применяется ко ВСЕМ людям сразу (в игре проверка `!p.bot`), поэтому
      // преимущества ни у кого нет. Раньше здесь стоял запрет на >1 игрока — из-за
      // него галочки в лобби с другом молча ничего не делали.
      room.infMoney = !!msg.infMoney;
      room.infArmy = !!msg.infArmy;
      broadcastLobby(room);
      break;
    }
    case 'spawn': {
      const room = st.room;
      if (!room || room.phase === 'lobby' || st.playerId === null) return;
      // Выбор точки старта — тоже команда: применится на границе хода, ответ
      // «spawned» отправим, когда узнаем результат (ошибка придёт из tick).
      const cell = msg.cell | 0;
      // Клетку проверяем сразу: команда применится только на тике, а в фазе высадки
      // мир не тикает — без этой проверки игрок узнал бы об отказе уже после старта
      // раунда, оставшись без территории.
      if (!room.game.canSpawnAt(st.playerId, cell)) {
        send(ws, { type: 'error', message: 'Здесь нельзя высадиться' });
        return;
      }
      room.game.enqueue({ t: 'spawn', id: st.playerId, cell });
      // Отметка о выборе живёт на соединении, а не в симуляции: по `player.spawned`
      // фаза высадки не заканчивалась бы досрочно (см. checkSpawnPhase).
      st.spawnPicked = true;
      send(ws, { type: 'spawned' });
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
        dropSnapshot(room); // снимок прошлого раунда непригоден
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
      room.game.enqueue({ t: 'attack', id: st.playerId, cell: msg.cell | 0, ratio: +msg.ratio });
      break;
    }
    case 'invade': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'invade', id: st.playerId, cell: msg.cell | 0, ratio: +msg.ratio });
      break;
    }
    case 'recall': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'recall', id: st.playerId, boatId: msg.boatId | 0 });
      break;
    }
    case 'build': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'build', id: st.playerId, bt: msg.bt, cell: msg.cell | 0 });
      break;
    }
    case 'upgrade': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'upgrade', id: st.playerId, cell: msg.cell | 0 });
      break;
    }
    case 'nuke': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'nuke', id: st.playerId, cell: msg.cell | 0, kind: msg.kind || 'basic' });
      break;
    }
    case 'warship': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'warship', id: st.playerId, cell: msg.cell | 0 });
      break;
    }
    case 'drones': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'drones', id: st.playerId, cell: msg.cell | 0 });
      break;
    }
    case 'warshipMove': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'warshipMove', id: st.playerId, ids: (msg.ids || []).map((n) => n | 0), cell: msg.cell | 0 });
      break;
    }
    case 'propose': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      // Предложение — тоже команда: ответы бота и предложение человеку игра положит
      // в исходящие ящики (relNotices / proposalsOut), сетевой слой их разошлёт.
      room.game.enqueue({ t: 'propose', id: st.playerId, cell: msg.cell | 0 });
      break;
    }
    case 'allianceResponse': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const from = msg.from | 0;
      if (!st.proposals.delete(from)) return; // не было такого предложения
      room.game.enqueue({ t: 'allianceResponse', id: st.playerId, from, accept: !!msg.accept });
      break;
    }
    case 'breakAlliance': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'breakAlliance', id: st.playerId, cell: msg.cell | 0 });
      break;
    }
    case 'war': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      room.game.enqueue({ t: 'war', id: st.playerId, cell: msg.cell | 0 });
      break;
    }
    case 'donate': {
      const room = st.room;
      if (!room || room.phase !== 'running' || st.playerId === null) return;
      const kind = msg.kind === 'troops' ? 'troops' : 'gold';
      room.game.enqueue({ t: 'donate', id: st.playerId, cell: msg.cell | 0, kind, amount: Number(msg.amount) || 0 });
      break;
    }
    case 'simResync': {
      // Локальной симуляции нужно состояние: клиент вошёл в идущую партию либо
      // разошёлся по хешу. Отдаём снимок — с него она продолжит счёт.
      sendSimSnapshot(ws, st);
      break;
    }
    case 'localSim': {
      // клиент поднял локальную симуляцию: дальше ему шлём только поток ходов
      const on = !!msg.on;
      // Выключил (симуляция не сошлась) — состояние мира снова его, но дельты за
      // время локального счёта потеряны: следующим кадром отдаём владельцев целиком.
      if (st.localSim && !on) st.needResync = true;
      st.localSim = on;
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
