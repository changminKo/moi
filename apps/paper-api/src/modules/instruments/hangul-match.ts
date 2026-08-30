import { disassemble, getChoseong } from 'es-hangul';
import type { Instrument } from './instrument-service.js';

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/u;
const CHOSEONG_ONLY = /^[ㄱ-ㅎ]+$/u;

export function matchesInstrument(
  query: string,
  instrument: Pick<Instrument, 'symbol' | 'name'>,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const symbol = instrument.symbol.toLowerCase();
  const name = instrument.name.toLowerCase();
  if (symbol.includes(normalizedQuery) || name.includes(normalizedQuery)) {
    return true;
  }
  if (CHOSEONG_ONLY.test(normalizedQuery)) {
    return getChoseong(name).includes(normalizedQuery);
  }
  return (
    HANGUL.test(normalizedQuery) &&
    disassemble(name).includes(disassemble(normalizedQuery))
  );
}
