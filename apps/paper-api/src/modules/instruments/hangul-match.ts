import { disassemble, getChoseong } from 'es-hangul';
import type { Instrument } from './instrument-service.js';

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/u;
const CHOSEONG_ONLY = /^[ㄱ-ㅎ]+$/u;

export function matchesInstrument(
  query: string,
  instrument: Pick<Instrument, 'symbol' | 'name'> & {
    readonly aliases?: readonly string[];
  },
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const candidates = [
    instrument.symbol,
    instrument.name,
    ...(instrument.aliases ?? []),
  ].map((candidate) => candidate.toLowerCase());
  if (candidates.some((candidate) => candidate.includes(normalizedQuery))) {
    return true;
  }
  const names = candidates.slice(1);
  if (CHOSEONG_ONLY.test(normalizedQuery)) {
    return names.some((name) => getChoseong(name).includes(normalizedQuery));
  }
  return (
    HANGUL.test(normalizedQuery) &&
    names.some((name) =>
      disassemble(name).includes(disassemble(normalizedQuery)),
    )
  );
}
