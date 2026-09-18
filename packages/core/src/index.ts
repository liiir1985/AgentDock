/**
 * The package's public surface. Consumers (the VS Code extension, a future headless entry point)
 * import from here and nowhere else, which is what keeps `packages/core` replaceable.
 */

export * from './adapter';
export * from './attribution';
export * from './baseline';
export * from './derive';
export * from './diff';
export * from './ledger';
export * from './lines';
export * from './model';
export * from './reconcile';
export * from './revert';
export * from './shell/intent';
export * from './verdict';
