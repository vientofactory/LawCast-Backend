const { createTransformer } = require('babel-jest');
const { pathToFileURL } = require('node:url');

module.exports = createTransformer({
  babelrc: false,
  configFile: false,
  plugins: [
    require.resolve('@babel/plugin-transform-modules-commonjs'),
    ({ types }) => ({
      visitor: {
        Program(program) {
          // Avoid collision with the CommonJS wrapper's require argument.
          if (program.scope.hasOwnBinding('require')) {
            program.scope.rename('require', 'esmRequire');
          }
        },
        MemberExpression(expression, state) {
          const node = expression.node;
          if (
            node.object.type === 'MetaProperty' &&
            node.object.meta.name === 'import' &&
            node.object.property.name === 'meta' &&
            node.property.type === 'Identifier' &&
            node.property.name === 'url'
          ) {
            expression.replaceWith(
              types.stringLiteral(pathToFileURL(state.file.opts.filename).href),
            );
          }
        },
      },
    }),
  ],
});
