import { BuildingType, Difficulty } from '../../shared/protocol';

// Внутренние сущности серверной симуляции (не путать с *Pub из shared/types)

export interface Player {
  id: number;
  name: string;
  troops: number;
  maxTroops: number;
  cells: number;
  alive: boolean;
  spawned: boolean; // человек ещё не выбрал точку старта — false
  bot: boolean;
  strong: boolean;
  passive: boolean; // слабые боты-«корм»: только расширяются в нейтраль
  growthMul: number;
  maxMul: number; // множитель потолка войск (у корма втрое меньше)
  money: number;
  thinkAt: number;
  spawnTick: number; // когда игрок высадился (для раннего буста роста)
  hurtTick: number; // последний тик, когда игрок терял клетку под атакой (для обороны)
}

export interface Building {
  id: number;
  owner: number;
  cell: number;
  type: BuildingType;
  readyTick: number; // тик, на котором постройка завершится
  level: number; // 1 обычный, 2 взрыв по области, 3 усиленный
  fuseTick: number; // тик взрыва после захвата (0 = не тикает)
  upStart: number; // тик начала апгрейда (0 = не улучшается)
  upEnd: number; // тик завершения апгрейда
  // Очередь ОТЛОЖЕННЫХ апгрейдов: сколько улучшений уже оплачено и ждёт своей
  // очереди после текущего. Нужна для ПВО и ракетных шахт, где апгрейд идёт 5с:
  // раньше повторный клик отвечал «Уже улучшается», и накликать сразу несколько
  // уровней было нельзя.
  upQueue: number;
  nextShipTick: number; // порт: когда выпускать следующий корабль
  ships: number; // порт: кораблей в полёте
  stock: number; // шахта: заряженных ракет сейчас (0..level)
  reloadTick: number; // шахта: когда добавить +1 ракету в залп
  reloads: number[]; // ПВО: тики восстановления израсходованных зарядов (параллельно)
}

export interface TradeShip {
  id: number;
  owner: number;
  portCell: number; // домашний порт (для учёта кораблей)
  destCell: number; // порт-назначение (если исчез/война — корабль тонет)
  path: number[]; // маршрут по воде
  cum: number[];
  totalLen: number;
  traveled: number;
  returning: boolean; // возвращается домой
  payout: number; // деньги за заход (с учётом уровня и дистанции)
  done: boolean; // рейс завершён — на удаление
  x: number;
  y: number;
}

export interface Missile {
  id: number;
  owner: number;
  kind: string; // ключ в NUKES
  sx: number; // старт (шахта)
  sy: number;
  tx: number; // цель
  ty: number;
  targetCell: number;
  prog: number; // 0..1
  flightTicks: number; // полное время полёта (по расстоянию)
  done: boolean;
  intercept: boolean; // true = перехватчик ПВО (летит к ядерке, не взрывается)
  killProg: number; // для ядерки: prog, на котором её собьёт ПВО (0 = не перехвачена)
}

export interface Attack {
  player: number;
  target: number; // id владельца-цели, 0 = нейтральная земля
  troops: number;
  frontier: Set<number>; // волна захвата, поддерживается инкрементально
  rescanned: boolean; // полный пересбор фронта уже был после опустошения
}

export interface Boat {
  // Маршрут лодки не меняется за весь рейс, поэтому шлём его КЛИЕНТУ ОДИН РАЗ, а
  // дальше только позицию. Раньше полная ломаная уходила каждый тик — по ~300 байт
  // на лодку, и при десятках десантов это были уже десятки килобайт в секунду.
  pathSent: boolean;
  id: number;
  player: number;
  target: number; // владелец берега-цели на момент отправки
  troops: number;
  path: number[]; // маршрут по воде: [x0,y0,x1,y1,...] в клетках
  cum: number[]; // накопленная дистанция в каждой точке пути (cum[0]=0)
  totalLen: number; // полная длина маршрута
  traveled: number; // пройдено вдоль маршрута (0..totalLen)
  returning: boolean; // отозван — возвращается к старту
  landCell: number; // клетка берега для высадки
  x: number; // текущая позиция на маршруте
  y: number;
}

// Боевой корабль: идёт к зоне по маршруту path, затем патрулирует её по кругу,
// стреляя по вражеским (hostile) судам в радиусе
export interface Warship {
  id: number;
  owner: number;
  x: number; // текущая позиция (клетки)
  y: number;
  path: number[]; // маршрут к зоне патруля [x0,y0,...]
  cum: number[];
  totalLen: number;
  traveled: number;
  moving: boolean; // true — идёт к зоне; false — патрулирует
  patrolX: number; // центр зоны патруля
  patrolY: number;
  patrolAng: number; // текущий угол на орбите
  hp: number; // здоровье (0..warshipMaxHp(xp))
  xp: number; // попаданий по чужим БОЕВЫМ кораблям — растит макс. hp и звание
  aaReloads: number[]; // тики восстановления зарядов ПВО (с 2 звания, см. warshipAaCharges)
  cooldown: number; // тиков до следующего выстрела
  hits: number; // сколько пуль прилетело с прошлой полной починки (время ремонта)
  repairing: boolean; // идёт в порт чиниться / стоит на ремонте
  healTicks: number; // тиков ремонта осталось (0 = не чинится)
  healRate: number; // прибавка hp за тик во время ремонта
}

// Грузовик завода: развозит золото по дорогам, посещая соединённые здания
// (города/порты), за каждое даёт монеты, затем возвращается на завод.
export interface Truck {
  id: number;
  owner: number;
  factoryCell: number; // домашний завод
  path: number[]; // ломаная по дорогам [x0,y0,x1,y1,...] (клетки), обход всей сети
  cum: number[]; // накопленная длина в каждой точке
  totalLen: number;
  traveled: number;
  payDist: number[]; // дистанции вдоль пути, где платить за здание
  payCell: number[]; // клетка здания для каждой payDist (параллельно)
  payIdx: number; // индекс следующей оплаты
  x: number;
  y: number;
  done: boolean; // рейс завершён / грузовик снят — на удаление
}

// Пуля боевого корабля: летит пикселем и догоняет цель, при попадании — урон
export interface Bullet {
  id: number;
  owner: number;
  fromId: number; // id выпустившего корабля (лимит активных пуль на корабль)
  x: number;
  y: number;
  targetId: number; // id цели
  targetKind: 'war' | 'trade' | 'boat' | 'drone'; // тип цели
  dmg: number;
}

// Дрон роя «Мопед»: летит над территорией цели, хаотично блуждая и бомбя её
export interface Drone {
  id: number;
  owner: number;
  target: number; // id страны-цели
  x: number;
  y: number;
  wx: number; // текущая точка блуждания
  wy: number;
  a: number; // курс (радианы)
  fireAt: number; // тик следующего сброса бомбы
  bombs: number; // осталось бомб; кончились — дрон падает и взрывается
  doomed: boolean; // по дрону уже летит ракета ПВО (чтобы не стрелять повторно)
  done: boolean;
}

// Снимок состояния симуляции: всё, от чего зависит дальнейший ход событий.
//
// Нужен клиентской симуляции в двух случаях:
//   • ПОЗДНЕЕ ПОДКЛЮЧЕНИЕ — догонять партию с нулевого хода нельзя (при 2.3 мс на тик
//     десять тысяч ходов это 23 секунды счёта), клиент поднимается из снимка;
//   • РАСХОЖДЕНИЕ — если хеши разошлись, клиент не продолжает врать картинкой, а
//     берёт снимок у сервера и продолжает с него.
//
// Карта (terrain) в снимок НЕ входит: она приходит в init и за партию не меняется.
// Производное (поле укреплений, связность воды, кэш морских маршрутов, список клеток
// по владельцу) тоже не входит — восстанавливается пересчётом.
export interface GameSnapshot {
  tickNo: number;
  rngState: number; // без него симуляции разъедутся с первого же случайного числа
  landCount: number;
  winnerId: number | null;
  difficulty: Difficulty;
  // счётчики id: новые юниты у клиента и сервера должны получать одинаковые номера
  ids: {
    player: number;
    boat: number;
    building: number;
    ship: number;
    warship: number;
    drone: number;
    truck: number;
    bullet: number;
    missile: number;
  };
  ownersRle: number[];
  // Список клеток по владельцу. ПОРЯДОК в нём влияет на симуляцию: боты сэмплируют
  // массив (каждая N-я клетка, случайный индекс), а порядок — это порядок захвата,
  // из карты владельцев его не вывести. Формат: [id, длина, Δ0, Δ1, ...] —
  // разности соседних индексов, потому что захват идёт полосами и числа выходят
  // маленькими (4.4 МБ → 3.5 МБ, после сжатия ~1.2 МБ).
  cellsOfEnc: number[];
  // Ключи уже посчитанных морских маршрутов. Сами пути не передаём (они выводятся
  // из карты) — важно лишь, что бюджет тика за них уже заплачен: иначе клиент с
  // пустым кэшем потратит бюджет там, где сервер его не тратил, и симуляции разойдутся.
  routeKeys: number[];
  // Дорожная сеть наращивается инкрементально: какие узлы уже соединены — это
  // история постройки, из текущего набора зданий её не вывести. Передаём только
  // КЛЮЧИ рёбер (пары узлов): сами дороги — функция от карты, пересчитаются.
  // Пары [ключ, начальная клетка]: Г-образная дорога зависит от того, с какого конца
  // её прокладывали (колено поворачивает в другом месте), а ключ порядок концов теряет.
  roadEdgeKeys: [number, number[]][];
  // Когда каждой паре «жертва — нападающий» в последний раз показали уведомление
  // (на симуляцию не влияет, но иначе восстановившийся клиент дублирует баннеры).
  attackNoticeAt: [number, number][];
  players: Player[];
  // frontier в JSON не сериализуется как Set — пишем массивом
  attacks: (Omit<Attack, 'frontier'> & { frontier: number[] })[];
  boats: Boat[];
  buildings: Building[];
  tradeShips: TradeShip[];
  warships: Warship[];
  drones: Drone[];
  trucks: Truck[];
  bullets: Bullet[];
  missiles: Missile[];
  allies: [number, number[]][];
  hostiles: [number, number[]][];
}
