import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { ASTParser } from '../parser.js';

describe('ASTParser multi-language', () => {
  let tmpDir: string;
  let parser: ASTParser;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astparser-'));
    parser = new ASTParser();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('extracts TypeScript classes, interfaces, functions, type aliases', () => {
    const file = write('foo.ts', `
export interface User { id: string }
export type ID = string;
export class Repo { find(id: ID): User { return { id } } }
export function helper() { return 1; }
`);
    const symbols = parser.parseFile(file);
    const byKind = (k: string) => symbols.filter(s => s.kind === k).map(s => s.name);
    expect(byKind('interface')).toEqual(['User']);
    expect(byKind('type')).toEqual(['ID']);
    expect(byKind('class')).toEqual(['Repo']);
    expect(byKind('function')).toEqual(['helper']);
  });

  it('extracts Python functions and classes', () => {
    const file = write('mod.py', `
def hello(name):
    return f"hi {name}"

class Greeter:
    def greet(self, name):
        return hello(name)
`);
    const symbols = parser.parseFile(file);
    const names = symbols.map(s => `${s.kind}:${s.name}`).sort();
    expect(names).toEqual(['class:Greeter', 'function:greet', 'function:hello']);
  });

  it('extracts Rust functions, structs, enums, traits', () => {
    const file = write('lib.rs', `
pub struct Point { pub x: i32 }
pub enum Color { Red, Green, Blue }
pub trait Show { fn show(&self) -> String; }
pub fn add(a: i32, b: i32) -> i32 { a + b }
impl Point {
    pub fn new() -> Self { Point { x: 0 } }
}
`);
    const symbols = parser.parseFile(file);
    const byKind = (k: string) => symbols.filter(s => s.kind === k).map(s => s.name).sort();
    expect(byKind('class')).toEqual(['Point']);
    expect(byKind('type')).toEqual(['Color']);
    expect(byKind('interface')).toEqual(['Show']);
    expect(byKind('function')).toEqual(['add', 'new']);
  });

  it('extracts Go functions, methods, structs, interfaces', () => {
    const file = write('main.go', `
package main

type Point struct { X int }
type Show interface { Show() string }

func Add(a, b int) int { return a + b }
func (p *Point) Move(dx int) { p.X += dx }
`);
    const symbols = parser.parseFile(file);
    const byKind = (k: string) => symbols.filter(s => s.kind === k).map(s => s.name).sort();
    expect(byKind('class')).toEqual(['Point']);
    expect(byKind('interface')).toEqual(['Show']);
    expect(byKind('function')).toEqual(['Add', 'Move']);
  });

  it('returns [] for unsupported extensions', () => {
    const file = write('readme.md', '# hello');
    expect(parser.parseFile(file)).toEqual([]);
  });

  it('returns [] for missing files', () => {
    expect(parser.parseFile(path.join(tmpDir, 'nope.ts'))).toEqual([]);
  });
});
