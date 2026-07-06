// RLE-кодирование карт: [значение, длина, значение, длина, ...]
// Карта в основном состоит из длинных полос воды/нейтрали — сжимается в сотни раз.

export function rleEncode(arr: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let run = 1;
    while (i + run < arr.length && arr[i + run] === v) run++;
    out.push(v, run);
    i += run;
  }
  return out;
}

export function rleDecode(rle: number[], out: { length: number; [i: number]: number }) {
  let i = 0;
  for (let k = 0; k < rle.length; k += 2) {
    const v = rle[k];
    const run = rle[k + 1];
    for (let j = 0; j < run; j++) out[i++] = v;
  }
}
