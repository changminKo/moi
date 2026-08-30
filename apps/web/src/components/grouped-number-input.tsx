import { useLayoutEffect, useRef } from 'react';
import {
  caretForSignificant,
  formatDecimalInput,
  significantBefore,
  stripGrouping,
} from '../lib/format-number';

/**
 * A numeric text field that shows thousands separators while the user types
 * but hands its owner a plain decimal string. Money never becomes a JS number
 * here: the value is grouped and stripped textually, so what the owner stores
 * is exactly what the API receives.
 *
 * The caret is preserved by anchoring it to the count of significant (non
 * separator) characters rather than to a raw offset — inserting a separator
 * earlier in the string therefore cannot push it to the end.
 */
export function GroupedNumberInput({
  id,
  value,
  onValueChange,
  inputMode = 'decimal',
  ...rest
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  inputMode?: 'numeric' | 'decimal';
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'id' | 'value' | 'onChange' | 'inputMode'
>) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const display = formatDecimalInput(value);

  // The caret is restored after React has written the reformatted value, which
  // would otherwise leave it at the end of the field.
  useLayoutEffect(() => {
    const position = caret.current;
    caret.current = null;
    if (position === null || !ref.current) return;
    ref.current.setSelectionRange(position, position);
  });

  const change = (event: React.ChangeEvent<HTMLInputElement>) => {
    const typed = event.target.value;
    // jsdom and programmatic fills report no selection; treat the caret as
    // sitting at the end, which is where such a write leaves it.
    const at = event.target.selectionStart ?? typed.length;
    const significant = significantBefore(typed, at);
    const raw = stripGrouping(typed);
    caret.current = caretForSignificant(formatDecimalInput(raw), significant);
    onValueChange(raw);
  };

  const keyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const at = input.selectionStart;
    if (
      event.key !== 'Backspace' ||
      at === null ||
      at !== input.selectionEnd ||
      at < 2 ||
      input.value[at - 1] !== ','
    )
      return;
    // Backspace immediately after a separator would otherwise delete the
    // separator alone, which the formatter puts straight back — visibly
    // nothing happens. Remove the digit in front of it instead.
    event.preventDefault();
    const next = input.value.slice(0, at - 2) + input.value.slice(at);
    const significant = significantBefore(next, at - 2);
    const raw = stripGrouping(next);
    caret.current = caretForSignificant(formatDecimalInput(raw), significant);
    onValueChange(raw);
  };

  return (
    <input
      {...rest}
      id={id}
      ref={ref}
      inputMode={inputMode}
      value={display}
      onChange={change}
      onKeyDown={keyDown}
    />
  );
}
