export function lineMap(content: Buffer | string): (byteOffset: number) => number {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const newlines: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) newlines.push(index);
  }
  return (byteOffset: number): number => {
    const offset = Number.isFinite(byteOffset) ? Math.max(0, Math.trunc(byteOffset)) : 0;
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((newlines[middle] as number) < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}
