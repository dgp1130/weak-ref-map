import {describe, expect, it} from 'vitest';
import {hello} from './index.js';

describe('hello', () => {
  it('should say hello', () => {
    expect(hello('World')).toBe('Hello, World!');
  });
});
