import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupedNumberInput } from './grouped-number-input';

afterEach(cleanup);

function Harness({
  initial = '',
  onValue = () => undefined,
}: {
  initial?: string;
  onValue?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="amount">Amount</label>
      <GroupedNumberInput
        id="amount"
        inputMode="decimal"
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onValue(next);
        }}
      />
      <output>{value}</output>
    </>
  );
}

const field = () => screen.getByLabelText('Amount') as HTMLInputElement;

/**
 * Write a value the way the browser does, bypassing the `value` setter React
 * patches onto the node: assigning through that setter updates React's own
 * tracker, after which it treats the event as a no-op and never calls onChange.
 */
function setValue(input: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, next);
}

/** Type at the caret, leaving it after the inserted text as a browser would. */
function typeAt(input: HTMLInputElement, text: string, at: number) {
  setValue(input, input.value.slice(0, at) + text + input.value.slice(at));
  input.setSelectionRange(at + text.length, at + text.length);
  fireEvent.change(input);
}

describe('GroupedNumberInput', () => {
  it('groups digits as they are typed and reports the plain value', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(field(), { target: { value: '1000000' } });
    expect(field()).toHaveValue('1,000,000');
    // The owner never sees a separator: what it holds is what the API gets.
    expect(onValue).toHaveBeenLastCalledWith('1000000');
    expect(screen.getByRole('status')).toHaveTextContent('1000000');
  });

  it('accepts a value set directly, as Playwright fill does', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: '70000' } });
    expect(field()).toHaveValue('70,000');
    expect(screen.getByRole('status')).toHaveTextContent('70000');
  });

  it('keeps a half-typed decimal point and its fraction', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: '1234.' } });
    expect(field()).toHaveValue('1,234.');
    fireEvent.change(field(), { target: { value: '1,234.5' } });
    expect(field()).toHaveValue('1,234.5');
    expect(screen.getByRole('status')).toHaveTextContent('1234.5');
  });

  it('does not move the caret to the end when typing mid-number', () => {
    render(<Harness initial="1234567" />);
    const input = field();
    expect(input).toHaveValue('1,234,567');
    // Insert "9" between "4" and ",": 1,2349,567 -> raw 12349567 -> 12,349,567
    typeAt(input, '9', 5);
    expect(input).toHaveValue('12,349,567');
    expect(input.selectionStart).toBe(6);
  });

  it('keeps the caret after the typed digit when a separator appears', () => {
    render(<Harness initial="999" />);
    const input = field();
    typeAt(input, '0', 3);
    expect(input).toHaveValue('9,990');
    expect(input.selectionStart).toBe(5);
  });

  it('deletes the digit, not the separator, on backspace over a separator', () => {
    render(<Harness initial="1234" />);
    const input = field();
    expect(input).toHaveValue('1,234');
    input.setSelectionRange(2, 2); // caret sits just after the separator
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(input).toHaveValue('234');
    expect(screen.getByRole('status')).toHaveTextContent('234');
    expect(input.selectionStart).toBe(0);
  });

  it('leaves ordinary backspace to the browser', () => {
    render(<Harness initial="1234" />);
    const input = field();
    input.setSelectionRange(5, 5);
    const event = fireEvent.keyDown(input, { key: 'Backspace' });
    // Not intercepted: the browser performs the deletion itself.
    expect(event).toBe(true);
    expect(input).toHaveValue('1,234');
  });

  it('replaces a selection without corrupting the value', () => {
    render(<Harness initial="1234567" />);
    const input = field();
    setValue(input, '1,000');
    input.setSelectionRange(5, 5);
    fireEvent.change(input);
    expect(input).toHaveValue('1,000');
    expect(screen.getByRole('status')).toHaveTextContent('1000');
  });

  it('passes unparseable input straight through for validation to reject', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: '12a34' } });
    expect(field()).toHaveValue('12a34');
    expect(screen.getByRole('status')).toHaveTextContent('12a34');
  });

  it('keeps the numeric keyboard hint and forwards aria wiring', () => {
    render(
      <>
        <label htmlFor="q">Quantity</label>
        <GroupedNumberInput
          id="q"
          inputMode="numeric"
          value=""
          onValueChange={() => undefined}
          aria-describedby="err"
        />
      </>,
    );
    const input = screen.getByLabelText('Quantity');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('aria-describedby', 'err');
  });
});
