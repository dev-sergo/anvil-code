export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable';
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface Dependency {
  from: string;
  to: string;
}
