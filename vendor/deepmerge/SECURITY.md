# Local deepmerge security patch

Based on deepmerge 4.3.1 (MIT). Fixes GHSA-gcqx-w48m-w2h4 by defining own enumerable data properties instead of invoking the inherited `__proto__` setter while copying either merge operand. This is a local vendored patch, not an upstream release. Existing clone, array, symbol and custom-merge behavior is preserved. Run `node --test vendor/deepmerge/security.test.cjs`.
