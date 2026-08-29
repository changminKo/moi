import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './app';

describe('App', () => {
  it('renders the primary navigation and one main landmark', () => {
    render(<App />, { wrapper: MemoryRouter });

    expect(screen.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: '거래' })).toHaveAttribute(
      'href',
      '/trade',
    );
    expect(screen.getByRole('link', { name: '포트폴리오' })).toHaveAttribute(
      'href',
      '/portfolio',
    );
  });
});
