/**
 * Static extraction of the CLI tokens an engine adapter can pass to its
 * Provider CLI, used by the invocation-surface contract test.
 *
 * Static analysis rather than calling the private `buildArgs`: the tokens are
 * spread across conditional branches and across several methods (the run path,
 * the login probe, the model-list probe), so executing one method would need a
 * combinatorial sweep of every branch and would still miss the probes.
 *
 * Two extraction rules, both precise about what reaches the CLI: the body of a
 * `build*Args` method, and the argv passed to a spawn helper. Anything else —
 * a flag-shaped literal compared against, or an argv for a different binary —
 * is reported as unclassified rather than folded into the surface.
 *
 * Known gap: a CLI spawned through a helper absent from SPAWN_HELPERS is only
 * noticed via that unclassified report, so an argv of nothing but subcommands
 * (`['whoami']`) would slip through. Register new spawn helpers here.
 */
import ts from 'typescript'

/** Helpers that spawn the Provider CLI with an explicit argv array. */
const SPAWN_HELPERS = new Set(['runStatusProbe'])
/** Engine convention: the method that assembles the run invocation's argv. */
const ARGS_BUILDER_NAME = /^build[A-Za-z0-9]*Args$/
/** A complete flag token, e.g. `-p`, `--output-format`, `--allowedTools`. */
const FLAG_SHAPE = /^--?[A-Za-z][A-Za-z0-9-]*$/
/** Anything that merely starts like a flag — used for the completeness sweep. */
const FLAG_PREFIX = /^--?[A-Za-z]/

export interface EngineCliSurface {
  /** Sorted CLI tokens; `flag=value` when the value is a static literal. */
  surface: string[]
  /** Flag-shaped literals in the file that no extraction rule claimed. */
  unclassifiedFlags: string[]
}

function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/** Renders a template literal with `${}` standing in for each interpolation. */
function templateText(node: ts.Node): string | null {
  if (!ts.isTemplateExpression(node)) return null
  let text = node.head.text
  for (const span of node.templateSpans) text += `\${}${span.literal.text}`
  return text
}

/**
 * Turns an ordered argv fragment into tokens. A flag followed by a static value
 * becomes `flag=value` — for several CLIs the value is what a version
 * introduced (`--output-format stream-json`), so it belongs in the surface.
 */
function collectTokens(elements: readonly ts.Node[], out: Set<string>): void {
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]
    if (!element) continue
    const text = staticText(element)
    if (text === null) continue
    if (!FLAG_SHAPE.test(text)) {
      out.add(text)
      continue
    }
    const next = elements[index + 1]
    const nextStatic = next ? staticText(next) : null
    if (nextStatic !== null && !FLAG_SHAPE.test(nextStatic)) {
      out.add(`${text}=${nextStatic}`)
      index++
      continue
    }
    const nextTemplate = next ? templateText(next) : null
    if (nextTemplate !== null) {
      out.add(`${text}=${nextTemplate}`)
      index++
      continue
    }
    out.add(text)
  }
}

function isPushCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'push'
  )
}

function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return null
}

/** Every argv fragment inside a scope that is argv-building by definition. */
function collectFromScope(scope: ts.Node, out: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) collectTokens(node.elements, out)
    else if (isPushCall(node)) collectTokens(node.arguments, out)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(scope, visit)
}

/** Only the array literals assigned to `name` and the pushes onto it. */
function collectFromVariable(scope: ts.Node, name: string, out: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      collectTokens(node.initializer.elements, out)
    }
    if (
      isPushCall(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === name
    ) {
      collectTokens(node.arguments, out)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(scope, visit)
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionLike(current) && 'body' in current && current.body) return current.body
    current = current.parent
  }
  return null
}

function formatLocation(node: ts.Node, sourceFile: ts.SourceFile): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${sourceFile.fileName}:${line + 1}`
}

/**
 * Extracts the CLI invocation surface of one engine adapter.
 *
 * Throws when a spawn call passes an argv expression this extractor cannot
 * resolve — a guard that must fail loudly is worse than useless if it can
 * quietly skip a call site it does not understand.
 */
export function extractCliSurface(sourceText: string, fileName = 'engine.ts'): EngineCliSurface {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const surface = new Set<string>()
  const flagLiterals = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      ARGS_BUILDER_NAME.test(node.name.text) &&
      node.body
    ) {
      collectFromScope(node.body, surface)
    }

    if (ts.isCallExpression(node)) {
      const callee = calleeName(node)
      if (callee && SPAWN_HELPERS.has(callee)) {
        const argv = node.arguments[1]
        if (argv && ts.isArrayLiteralExpression(argv)) {
          collectTokens(argv.elements, surface)
        } else if (argv && ts.isIdentifier(argv)) {
          const scope = enclosingFunction(node)
          if (!scope) {
            throw new Error(
              `Cannot resolve argv variable "${argv.text}" at ${formatLocation(node, sourceFile)}`,
            )
          }
          collectFromVariable(scope, argv.text, surface)
        } else if (argv) {
          throw new Error(
            `Unsupported argv expression passed to ${callee} at ${formatLocation(node, sourceFile)}; extend extract-cli-surface.ts`,
          )
        }
      }
      // Values the run path pins at the call site rather than inside the
      // builder, e.g. `this.buildArgs(prompt, model, 'stream-json', ...)`.
      if (callee && ARGS_BUILDER_NAME.test(callee)) {
        for (const argument of node.arguments) {
          const text = staticText(argument)
          if (text !== null) surface.add(text)
        }
      }
    }

    const literal = staticText(node)
    if (literal !== null && FLAG_PREFIX.test(literal)) flagLiterals.add(literal)

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const claimed = (flag: string): boolean =>
    [...surface].some((token) => token === flag || token.startsWith(`${flag}=`))

  return {
    surface: [...surface].sort(),
    unclassifiedFlags: [...flagLiterals].filter((flag) => !claimed(flag)).sort(),
  }
}
