// Provides the methods that allow QueryManager to handle
// the `skip` and `include` directives within GraphQL.

import {
  SelectionSet,
  Directive,
  Selection,
  Document,
  InlineFragment,
  Field,
  BooleanValue,
  Variable,
} from 'graphql';

import {
  getQueryDefinition,
  getFragmentDefinitions,
} from './getFromAST';

import identity = require('lodash.identity');
import cloneDeep = require('lodash.clonedeep');

// A handler that takes a selection, variables, and a directive to apply to that selection.
export type DirectiveResolver = (selection: Selection,
                                 variables: { [name: string]: any },
                                 directive: Directive) => Selection

export function applyDirectives(doc: Document,
                                variables?: { [name: string]: any },
                                directiveResolvers?: { [name: string]: DirectiveResolver} )
: Document {
  if (!variables) {
    variables = {};
  }
  if (!directiveResolvers) {
    directiveResolvers = {};
  }

  const newDoc = cloneDeep(doc);
  const fragmentDefs = getFragmentDefinitions(newDoc);
  const queryDef = getQueryDefinition(newDoc);
  const newSelSet = applyDirectivesToSelectionSet(queryDef.selectionSet,
                                                  variables,
                                                  directiveResolvers);
  queryDef.selectionSet = newSelSet;
  newDoc.definitions = fragmentDefs.map((fragmentDef) => {
    const fragmentSelSet = applyDirectivesToSelectionSet(fragmentDef.selectionSet,
                                                         variables,
                                                         directiveResolvers);
    fragmentDef.selectionSet = fragmentSelSet;
    return fragmentDef;
  });
  newDoc.definitions.unshift(queryDef);

  return newDoc;
}

export function applyDirectivesToSelectionSet(selSet: SelectionSet,
                                              variables: { [name: string]: any },
                                              directiveResolvers: {
                                                [name: string]: DirectiveResolver})
: SelectionSet {

  const selections = selSet.selections;
  selSet.selections = selections.map((selection) => {

    let newSelection: Selection = selection;
    let currSelection: Selection = selection;
    let toBeRemoved = null;

    selection.directives.forEach((directive) => {
      if (directive.name && directive.name.value) {
        const directiveResolver = directiveResolvers[directive.name.value];
        newSelection = directiveResolver(currSelection, variables, directive);

        // add handling for the case where we have both a skip and an include
        // on the same field (see note here: http://facebook.github.io/graphql/#sec--include).
        if (directive.name.value === 'skip' || directive.name.value === 'include') {
          if (newSelection === undefined && toBeRemoved === null) {
            toBeRemoved = true;
          } else if (newSelection === undefined) {
            currSelection = selection;
          }
          if (newSelection) {
            toBeRemoved = false;
            currSelection = newSelection;
          }
        }
      }
    });

    if (newSelection !== undefined) {
      const withSelSet = selection as (InlineFragment | Field);
      // recursively operate on selection sets within this selection set.
      if (withSelSet.kind === 'InlineFragment' ||
          (withSelSet.kind === 'Field' && withSelSet.selectionSet)) {
        withSelSet.selectionSet = applyDirectivesToSelectionSet(withSelSet.selectionSet,
                                                               variables,
                                                               directiveResolvers);
      }
      return newSelection;
    } else if (!toBeRemoved) {
      return currSelection;
    }
  });

  //filter out undefined values
  selSet.selections = selSet.selections.filter(identity);
  return selSet;
}

export function skipIncludeDirectiveResolver(directiveName: string,
                                             selection: Selection,
                                             variables: { [name: string]: any },
                                             directive: Directive)
: Selection {
  //evaluate the "if" argument and skip (i.e. return undefined) if it evaluates to true.
  const directiveArguments = directive.arguments;
  if (directiveArguments.length !== 1) {
    throw new Error(`Incorrect number of arguments for the @$(directiveName} directive.`);
  }

  const ifArgument = directive.arguments[0];
  if (!ifArgument.name || ifArgument.name.value !== 'if') {
    throw new Error(`Invalid argument for the @${directiveName} directive.`);
  }

  const ifValue = directive.arguments[0].value;
  let evaledValue: Boolean = false;
  if (!ifValue || ifValue.kind !== 'BooleanValue') {
    // means it has to be a variable value if this is a valid @skip directive
    if (ifValue.kind !== 'Variable') {
      throw new Error(`Invalid argument value for the @${directiveName} directive.`);
    } else {
      evaledValue = variables[(ifValue as Variable).name.value];
      if (evaledValue === undefined) {
        throw new Error(`Invalid variable referenced in @${directiveName} directive.`);
      }
    }
  } else {
    evaledValue = (ifValue as BooleanValue).value;
  }

  if (directiveName === 'skip') {
    evaledValue = !evaledValue;
  }

  // if the value is false, then don't skip it.
  if (evaledValue) {
    return selection;
  } else {
    return undefined;
  }
}

export function skipDirectiveResolver(selection: Selection,
                                      variables: { [name: string]: any },
                                      directive: Directive)
: Selection {
  return skipIncludeDirectiveResolver('skip', selection, variables, directive);
}

export function includeDirectiveResolver(selection: Selection,
                                         variables: { [name: string]: any },
                                         directive: Directive)
: Selection {
  return skipIncludeDirectiveResolver('include', selection, variables, directive);
}

export function applySkipResolver(doc: Document, variables?: { [name: string]: any })
: Document {
  return applyDirectives(doc, variables, {
    'skip': skipDirectiveResolver,
  });
}

export function applyIncludeResolver(doc: Document, variables?: { [name: string]: any })
: Document {
  return applyDirectives(doc, variables, {
    'include': includeDirectiveResolver,
  });
}
