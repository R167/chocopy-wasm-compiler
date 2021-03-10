import {
  Stmt,
  Expr,
  UniOp,
  BinOp,
  Type,
  Program,
  Literal,
  FunDef,
  VarInit,
  Class,
  Assignable,
  Destructure,
} from "./ast";
import { NUM, BOOL, STRING, NONE, unhandledTag, unreachable } from "./utils";
import * as BaseException from "./error";

// https://learnxinyminutes.com/docs/wasm/

// Numbers are offsets into global memory
export type GlobalEnv = {
  globals: Map<string, number>;
  classes: Map<string, Map<string, [number, Literal]>>;
  locals: Set<string>;
  offset: number;
};

export const emptyEnv: GlobalEnv = {
  globals: new Map(),
  classes: new Map(),
  locals: new Set(),
  offset: 0,
};

export function augmentEnv(env: GlobalEnv, prog: Program<Type>): GlobalEnv {
  const newGlobals = new Map(env.globals);
  const newClasses = new Map(env.classes);

  var newOffset = env.offset;
  prog.inits.forEach((v) => {
    newGlobals.set(v.name, newOffset);
    newOffset += 1;
  });
  prog.classes.forEach((cls) => {
    const classFields = new Map();
    cls.fields.forEach((field, i) => classFields.set(field.name, [i, field.value]));
    newClasses.set(cls.name, classFields);
  });
  return {
    globals: newGlobals,
    classes: newClasses,
    locals: env.locals,
    offset: newOffset,
  };
}

type CompileResult = {
  functions: string;
  mainSource: string;
  newEnv: GlobalEnv;
};

// export function getLocals(ast : Array<Stmt>) : Set<string> {
//   const definedVars : Set<string> = new Set();
//   ast.forEach(s => {
//     switch(s.tag) {
//       case "define":
//         definedVars.add(s.name);
//         break;
//     }
//   });
//   return definedVars;
// }

export function makeLocals(locals: Set<string>): Array<string> {
  const localDefines: Array<string> = [];
  locals.forEach((v) => {
    localDefines.push(`(local $${v} i32)`);
  });
  return localDefines;
}

export function compile(ast: Program<Type>, env: GlobalEnv): CompileResult {
  const withDefines = augmentEnv(env, ast);

  const definedVars: Set<string> = new Set(); //getLocals(ast);
  definedVars.add("$last");
  definedVars.add("$list_base");
  definedVars.add("$list_index");
  definedVars.add("$list_temp");
  definedVars.add("$list_cmp");
  definedVars.add("$destruct");
  definedVars.add("$string_val"); //needed for string operations
  definedVars.add("$string_class"); //needed for strings in class
  definedVars.add("$string_index"); //needed for string index check out of bounds
  definedVars.add("$string_address"); //needed for string indexing
  definedVars.forEach(env.locals.add, env.locals);
  const localDefines = makeLocals(definedVars);
  const funs: Array<string> = [];
  ast.funs.forEach((f) => {
    funs.push(codeGenDef(f, withDefines).join("\n"));
  });
  const classes: Array<string> = ast.classes.map((cls) => codeGenClass(cls, withDefines)).flat();
  const allFuns = funs.concat(classes).join("\n\n");
  // const stmts = ast.filter((stmt) => stmt.tag !== "fun");
  const inits = ast.inits.map((init) => codeGenInit(init, withDefines)).flat();
  const commandGroups = ast.stmts.map((stmt) => codeGenStmt(stmt, withDefines));
  const commands = localDefines.concat(inits.concat(...commandGroups));
  withDefines.locals.clear();
  return {
    functions: allFuns,
    mainSource: commands.join("\n"),
    newEnv: withDefines,
  };
}

function envLookup(env: GlobalEnv, name: string): number {
  if (!env.globals.has(name)) {
    console.log("Could not find " + name + " in ", env);
    throw new Error("Could not find name " + name);
  }
  return env.globals.get(name) * 4; // 4-byte values
}

function codeGenStmt(stmt: Stmt<Type>, env: GlobalEnv): Array<string> {
  switch (stmt.tag) {
    // case "fun":
    //   const definedVars = getLocals(stmt.body);
    //   definedVars.add("$last");
    //   stmt.parameters.forEach(p => definedVars.delete(p.name));
    //   definedVars.forEach(env.locals.add, env.locals);
    //   stmt.parameters.forEach(p => env.locals.add(p.name));

    //   const localDefines = makeLocals(definedVars);
    //   const locals = localDefines.join("\n");
    //   var params = stmt.parameters.map(p => `(param $${p.name} i32)`).join(" ");
    //   var stmts = stmt.body.map((innerStmt) => codeGenStmt(innerStmt, env)).flat();
    //   var stmtsBody = stmts.join("\n");
    //   env.locals.clear();
    //   return [`(func $${stmt.name} ${params} (result i32)
    //     ${locals}
    //     ${stmtsBody}
    //     (i32.const 0)
    //     (return))`];
    case "return":
      var valStmts = codeGenExpr(stmt.value, env);
      valStmts.push("return");
      return valStmts;
    case "assignment":
      const valueCode = codeGenExpr(stmt.value, env);
      const getValue = "(local.get $$destruct)";

      return [
        ...valueCode,
        "local.set $$destruct",
        ...codeGenDestructure(stmt.destruct, getValue, env),
      ];
    case "expr":
      var exprStmts = codeGenExpr(stmt.expr, env);
      return exprStmts.concat([`(local.set $$last)`]);
    case "if":
      var condExpr = codeGenExpr(stmt.cond, env);
      var thnStmts = stmt.thn.map((innerStmt) => codeGenStmt(innerStmt, env)).flat();
      var elsStmts = stmt.els.map((innerStmt) => codeGenStmt(innerStmt, env)).flat();
      return [
        `${condExpr.join("\n")} \n (if (then ${thnStmts.join("\n")}) (else ${elsStmts.join(
          "\n"
        )}))`,
      ];
    case "while":
      var wcondExpr = codeGenExpr(stmt.cond, env);
      var bodyStmts = stmt.body.map((innerStmt) => codeGenStmt(innerStmt, env)).flat();
      return [
        `(block (loop (br_if 1 ${wcondExpr.join("\n")}\n(i32.eqz)) ${bodyStmts.join(
          "\n"
        )} (br 0) ))`,
      ];
    case "pass":
      return [];
    default:
      unhandledTag(stmt);
  }
}

/**
 * Generate assign statements as described by the destructuring term
 * @param destruct Destructuring description of assign targets
 * @param value WASM code literal value for fetching the referenced value. E.g. "(local.get $$myValue)"
 * @param env GlobalEnv
 */
function codeGenDestructure(destruct: Destructure<Type>, value: string, env: GlobalEnv): string[] {
  let assignStmts: string[] = [];

  if (destruct.isDestructured) {
    const objTyp = destruct.valueType;
    switch (objTyp.tag) {
      case "class": {
        const className = objTyp.name;
        const classFields = env.classes.get(className).values();
        // Collect every assignStmt

        assignStmts = destruct.targets.flatMap(({ target }) => {
          const [offset, _] = classFields.next().value;
          // The WASM code value that we extracted from the object at this current offset
          const addressOffset = offset * 4;
          const fieldValue = [`(i32.add ${value} (i32.const ${addressOffset}))`, `(i32.load)`];

          return codeGenAssignable(target, fieldValue, env);
        });
        break;
      }
      case "tuple": {
        let offset = 0;
        for (let target of destruct.targets) {
          if (target.starred) {
            throw new Error("Do not currently support starred assignment targets");
          } else if (!target.ignore) {
            let fieldValue = [value, `(i32.load offset=${offset})`];
            assignStmts.push(...codeGenAssignable(target.target, fieldValue, env));
            offset += 4;
          }
        }
        break;
      }
      default:
        throw new Error(`Destructuring not supported yet for type ${objTyp.tag}`);
    }
  } else {
    const target = destruct.targets[0];
    if (!target.ignore) {
      assignStmts = codeGenAssignable(target.target, [value], env);
    }
  }

  return assignStmts;
}

function codeGenAssignable(target: Assignable<Type>, value: string[], env: GlobalEnv): string[] {
  switch (target.tag) {
    case "id": // Variables
      if (env.locals.has(target.name)) {
        return [...value, `(local.set $${target.name})`];
      } else {
        const locationToStore = [`(i32.const ${envLookup(env, target.name)}) ;; ${target.name}`];
        return [...locationToStore, ...value, "(i32.store)"];
      }
    case "lookup": // Field lookup
      const objStmts = codeGenExpr(target.obj, env);
      const objTyp = target.obj.a;
      if (objTyp.tag !== "class") {
        // I don't think this error can happen
        throw new Error(
          "Report this as a bug to the compiler developer, this shouldn't happen " + objTyp.tag
        );
      }
      const className = objTyp.name;
      const [offset, _] = env.classes.get(className).get(target.field);
      return [...objStmts, `(i32.add (i32.const ${offset * 4}))`, ...value, `(i32.store)`];
    default:
      // Force type error if assignable is added without implementation
      // At the very least, there should be a stub
      const err: never = <never>target;
      throw new Error(`Unknown target ${JSON.stringify(err)} (compiler)`);
  }
}

function codeGenInit(init: VarInit<Type>, env: GlobalEnv): Array<string> {
  const value = codeGenLiteral(init.value, env);
  if (env.locals.has(init.name)) {
    return [...value, `(local.set $${init.name})`];
  } else {
    const locationToStore = [`(i32.const ${envLookup(env, init.name)}) ;; ${init.name}`];
    return locationToStore.concat(value).concat([`(i32.store)`]);
  }
}

function codeGenDef(def: FunDef<Type>, env: GlobalEnv): Array<string> {
  var definedVars: Set<string> = new Set();
  def.inits.forEach((v) => definedVars.add(v.name));
  definedVars.add("$last");
  definedVars.add("$destruct");
  definedVars.add("$string_val"); //needed for string operations
  definedVars.add("$string_class"); //needed for strings in class
  definedVars.add("$string_index"); //needed for string index check out of bounds
  definedVars.add("$string_address"); //needed for string indexing
  // def.parameters.forEach(p => definedVars.delete(p.name));
  definedVars.forEach(env.locals.add, env.locals);
  def.parameters.forEach((p) => env.locals.add(p.name));

  const localDefines = makeLocals(definedVars);
  const locals = localDefines.join("\n");
  const inits = def.inits
    .map((init) => codeGenInit(init, env))
    .flat()
    .join("\n");
  var params = def.parameters.map((p) => `(param $${p.name} i32)`).join(" ");
  var stmts = def.body.map((innerStmt) => codeGenStmt(innerStmt, env)).flat();
  var stmtsBody = stmts.join("\n");
  env.locals.clear();
  return [
    `(func $${def.name} ${params} (result i32)
    ${locals}
    ${inits}
    ${stmtsBody}
    (i32.const 0)
    (return))`,
  ];
}

function codeGenClass(cls: Class<Type>, env: GlobalEnv): Array<string> {
  const methods = [...cls.methods];
  methods.forEach((method) => (method.name = `${cls.name}$${method.name}`));
  const result = methods.map((method) => codeGenDef(method, env));
  return result.flat();
}

// If concat is 0, then the function generate code for list.copy()
// If concat is 2, then the function generate code for concat.
function codeGenListCopy(concat: number): Array<string> {
  var stmts: Array<string> = [];
  var loopstmts: Array<string> = [];
  var condstmts: Array<string> = [];
  var listType = 10; //temporary list type number
  var header = [4, 8]; //size, bound relative position
  stmts.push(...[`(local.set $$list_cmp)`]); //store first address to local var
  stmts.push(...[`(i32.load (i32.const 0))`, `(local.set $$list_base)`]); //store the starting address for the new list
  if (concat != 1)
    stmts.push(...[`(local.get $$list_base)`, "(i32.const " + listType + ")", "(i32.store)"]); //create a new list with type

  //check if the current index has reached the size of the list
  condstmts.push(
    ...[
      `(local.get $$list_cmp)`,
      `(i32.add (i32.const 4))`,
      `(i32.load)`,
      `(local.get $$list_index)`,
      `(i32.eq)`,
    ]
  );

  //statement for loop through the compared list and add the elements to the new list
  loopstmts.push(
    ...[
      `(local.get $$list_base)`,
      `(i32.add (i32.const 12))`,
      `(local.get $$list_index)`,
      concat == 1 ? `(i32.add (local.get $$list_temp))` : ``,
      `(i32.mul (i32.const 4))`,
      `(i32.add)`,
      `(local.get $$list_cmp)`,
      `(i32.add (i32.const 12))`,
      `(local.get $$list_index)`,
      `(i32.mul (i32.const 4))`,
      `(i32.add)`,
      `(i32.load)`,
      `(i32.store)`,
      `(local.get $$list_index)`,
      `(i32.add (i32.const 1))`,
      `(local.set $$list_index)`,
    ]
  );

  if (concat == 1) {
    stmts.push(
      ...[
        `(local.get $$list_base)`,
        `(i32.add (i32.const 4))`,
        `(i32.load)`,
        `(local.set $$list_temp)`,
      ]
    );
  }

  //while loop structure
  stmts.push(
    ...[
      `(i32.const 0)`,
      `(local.set $$list_index)`,
      `(block`,
      `(loop`,
      `(br_if 1 ${condstmts.join("\n")})`,
      `${loopstmts.join("\n")}`,
      `(br 0)`,
      `)`,
      `)`,
    ]
  );

  //add/modify header info of the list
  header.forEach((addr) => {
    var stmt = null;
    if (concat == 1) {
      stmt = [
        `(local.get $$list_base)`,
        `(i32.add (i32.const ${addr}))`,
        `(local.get $$list_base)`,
        `(i32.add (i32.const ${addr}))`,
        `(i32.load)`,
        `(local.get $$list_cmp)`,
        `(i32.add (i32.const ${addr}))`,
        `(i32.load)`,
        `(i32.add)`,
        `(i32.store)`,
      ];
    } else {
      stmt = [
        `(local.get $$list_base)`,
        `(i32.add (i32.const ${addr}))`,
        `(local.get $$list_cmp)`,
        `(i32.add (i32.const ${addr}))`,
        `(i32.load)`,
        `(i32.store)`,
      ];
    }
    stmts.push(...stmt);
  });

  if (concat == 2) return stmts.concat(codeGenListCopy(1));

  return stmts.concat([
    `(local.get $$list_base)`, // Get address for the object (this is the return value)
    "(i32.const 0)", // Address for our upcoming store instruction
    `(local.get $$list_base)`, // Load the dynamic heap head offset
    `(local.get $$list_cmp)`,
    `(i32.add (i32.const 8))`,
    `(i32.load)`,
    `(i32.mul (i32.const 4))`,
    `(i32.add (i32.const 12))`,
    `(i32.add)`,
    "(i32.store)", // Save the new heap offset
  ]);
}

function codeGenExpr(expr: Expr<Type>, env: GlobalEnv): Array<string> {
  switch (expr.tag) {
    case "builtin1":
      const argTyp = expr.a;
      const argStmts = codeGenExpr(expr.arg, env);
      var callName = expr.name;
      if (expr.name === "print" && argTyp === NUM) {
        callName = "print_num";
      } else if (expr.name === "print" && argTyp === STRING) {
        callName = "print_str";
      } else if (expr.name === "print" && argTyp === BOOL) {
        callName = "print_bool";
      } else if (expr.name === "print" && argTyp === NONE) {
        callName = "print_none";
      }
      return argStmts.concat([`(call $${callName})`]);
    case "builtin2":
      const leftStmts = codeGenExpr(expr.left, env);
      const rightStmts = codeGenExpr(expr.right, env);
      return [...leftStmts, ...rightStmts, `(call $${expr.name})`];
    case "literal":
      return codeGenLiteral(expr.value, env);
    case "id":
      if (env.locals.has(expr.name)) {
        return [`(local.get $${expr.name})`];
      } else {
        return [`(i32.const ${envLookup(env, expr.name)})`, `(i32.load)`];
      }
    case "binop":
      const lhsStmts = codeGenExpr(expr.left, env);
      const rhsStmts = codeGenExpr(expr.right, env);
      if (typeof expr.left.a !== "undefined" && expr.left.a.tag === "list")
        return [...rhsStmts, ...lhsStmts, ...codeGenListCopy(2)];
      return [...lhsStmts, ...rhsStmts, codeGenBinOp(expr.op)];
    case "uniop":
      const exprStmts = codeGenExpr(expr.expr, env);
      switch (expr.op) {
        case UniOp.Neg:
          return [`(i32.const 0)`, ...exprStmts, `(i32.sub)`];
        case UniOp.Not:
          return [`(i32.const 0)`, ...exprStmts, `(i32.eq)`];
        default:
          return unreachable(expr);
      }
    case "call":
      var valStmts = expr.arguments.map((arg) => codeGenExpr(arg, env)).flat();
      valStmts.push(`(call $${expr.name})`);
      return valStmts;
    case "construct":
      var stmts: Array<string> = [];
      stmts.push(
        ...[
          "(i32.const 0)", // Address for our upcoming store instruction
          "(i32.load (i32.const 0))", // Load the dynamic heap head offset
          "(local.set $$string_class)",
          "(i32.load (i32.const 0))",
          `(i32.add (i32.const ${env.classes.get(expr.name).size * 4}))`, // Move heap head beyond the k words we just created for fields
          "(i32.store)", // Save the new heap offset
        ]
      );
      env.classes.get(expr.name).forEach(([offset, initVal], field) =>
        stmts.push(
          ...[
            `(local.get $$string_class)`,
            `(i32.add (i32.const ${offset * 4}))`, // Calc field offset from heap offset
            ...codeGenLiteral(initVal, env), // Initialize field
            "(i32.store)", // Put the default field value on the heap
          ]
        )
      );
      stmts.push(
        ...[
          "(local.get $$string_class)",
          `(call $${expr.name}$__init__)`, // call __init__
          "(drop)",
          "(local.get $$string_class)",
        ]
      );
      return stmts;
    case "method-call":
      var objStmts = codeGenExpr(expr.obj, env);
      var objTyp = expr.obj.a;
      if (objTyp.tag !== "class") {
        // I don't think this error can happen
        throw new Error(
          "Report this as a bug to the compiler developer, this shouldn't happen " + objTyp.tag
        );
      }
      var className = objTyp.name;
      var argsStmts = expr.arguments.map((arg) => codeGenExpr(arg, env)).flat();
      return [...objStmts, ...argsStmts, `(call $${className}$${expr.method})`];
    case "lookup":
      var objStmts = codeGenExpr(expr.obj, env);
      var objTyp = expr.obj.a;
      if (objTyp.tag !== "class") {
        // I don't think this error can happen
        throw new Error(
          "Report this as a bug to the compiler developer, this shouldn't happen " + objTyp.tag
        );
      }
      var className = objTyp.name;
      var [offset, _] = env.classes.get(className).get(expr.field);
      return [...objStmts, `(i32.add (i32.const ${offset * 4}))`, `(i32.load)`];
    case "bracket-lookup":
      if (expr.a.tag == "string") {
        var brObjStmts = codeGenExpr(expr.obj, env);
        var brKeyStmts = codeGenExpr(expr.key, env);
        var brStmts = [];
        brStmts.push(
          ...[
            `${brObjStmts.join("\n")}`, //Load the string object to be indexed
            `(local.set $$string_address)`,
            `${brKeyStmts.join("\n")}`, //Gets the index
            `(local.set $$string_index)`,
            `(local.get $$string_index)`,
            `(i32.const 0)(i32.lt_s)`, //check for negative index
            `(if (then (local.get $$string_address)(i32.load)(i32.add (i32.const 1))(local.get $$string_index)(i32.add)(local.set $$string_index)))`, //if -ve, we do length + index
            `(local.get $$string_index)(local.get $$string_address)(i32.load)(i32.gt_s)`, //Check for +ve index out of bounds
            `(local.get $$string_index)(i32.const 0)(i32.lt_s)`, //Check for -ve index out of bounds
            `(i32.or)`, // Check if string index is within bounds, i.e, b/w 0 and string_length
            `(if (then (i32.const -1)(call $print_str)(drop)))`, //Check if string index is out of bounds
            `(local.get $$string_address)`,
            `(i32.add (i32.mul (i32.const 4)(local.get $$string_index)))`, //Add the index * 4 value to the address
            `(i32.add (i32.const 4))`, //Adding 4 since string length is at first index
            `(i32.load)`, //Load the ASCII value of the string index
            `(local.set $$string_val)`, //store value in temp variable
            `(i32.load (i32.const 0))`, //load value at 0
            `(i32.const 0)`, //Length of string is 1
            `(i32.store)`, //Store length of string in the first position
            `(i32.load (i32.const 0))`, //Load latest free memory
            `(i32.add (i32.const 4))`, //Add 4 since we have stored string length at beginning
            `(local.get $$string_val)`, //load value in temp variable
            "(i32.store)", //Store the ASCII value in the new address
          ]
        );
        brStmts.push(
          ...[
            "(i32.load (i32.const 0))", // Get address for the indexed character of the string
            "(i32.const 0)", // Address for our upcoming store instruction
            "(i32.load (i32.const 0))", // Load the dynamic heap head offset
            `(i32.add (i32.const 8))`, // Move heap head beyond the string length
            "(i32.store)", // Save the new heap offset
          ]
        );
        return brStmts;
      } else if (expr.obj.a.tag == "list") {
        var objStmts = codeGenExpr(expr.obj, env);
        //This should eval to a number
        //Multiply it by 4 to use as offset in memory
        var keyStmts = codeGenExpr(expr.key, env);
        //Add 3 to keyStmts to jump over type + size + bound
        //Add that to objStmts base address
        //Load from there
        return objStmts.concat(
          //TODO check for IndexOutOfBounds
          //Coordinate with error group
          /*
          [
            `(i32.add (i32.4)) ;; retrieve list size`,
            `(i32.load)`,
          // size > index
          ],
            keyStmts,
          [
            `(i32.gt_s) ;; compare list size > index`
            `(if (then (call $error)) (else (nop))) ;; call IndexOutOfBounds`
          ],
            objStmts, //reload list base addr & key stmts?
          */
          keyStmts,
          [
            `(i32.mul (i32.const 4))`,
            `(i32.add (i32.const 12)) ;; move past type, size, bound`,
            `(i32.add) ;; retrieve element location`,
            `(i32.load) ;; load list element`,
          ]
        );
      } else if (expr.obj.a.tag == "tuple") {
        return [
          // Get tuple address
          ...codeGenExpr(expr.obj, env),
          // Get word offset from tuple address
          ...codeGenExpr(expr.key, env),
          // Get byte offset
          "(i32.mul (i32.const 4))",
          // Calculate target address
          "(i32.add)",
          // Load target value
          "(i32.load)",
        ];
      }
      break;

    case "list-expr":
      var stmts: Array<string> = [];
      var listType = 10;
      var listSize = expr.contents.length;
      var listBound = (expr.contents.length + 10) * 2;
      let listHeader = [listType, listSize, listBound];
      var listindex = 0;
      expr.contents
        .slice()
        .reverse()
        .forEach((lexpr) => {
          stmts.push(...[...codeGenExpr(lexpr, env)]);
        });

      listHeader.forEach((val) => {
        stmts.push(
          ...[
            `(i32.load (i32.const 0))`,
            `(i32.add (i32.const ${listindex * 4}))`,
            "(i32.const " + val + ")",
            "(i32.store)",
          ]
        );
        listindex += 1;
      });

      expr.contents.forEach((lexpr) => {
        stmts.push(
          ...[
            `(local.set $$list_temp)`,
            `(i32.load (i32.const 0))`,
            `(i32.add (i32.const ${listindex * 4}))`,
            `(local.get $$list_temp)`,
            "(i32.store)",
          ]
        );
        listindex += 1;
      });

      //Move heap head to the end of the list and return list address
      return stmts.concat([
        "(i32.load (i32.const 0))",
        "(i32.const 0)",
        "(i32.load (i32.const 0))",
        `(i32.add (i32.const ${(listBound + 3) * 4}))`,
        "(i32.store)",
      ]);
    case "tuple-expr": {
      // Much of this logic is copied from object construction. Is there a way to easily reuse that logic?
      let stmts = [
        "(i32.const 0)", // Address for our upcoming store instruction
        "(i32.load (i32.const 0))", // Load the dynamic heap head offset
        "(local.set $$string_class)",
        "(local.get $$string_class)",
        `(i32.add (i32.const ${expr.contents.length * 4}))`, // Move heap head beyond the k words we just created for
        // tuple items
        "(i32.store)", // Save the new heap offset
      ];
      expr.contents.forEach((content, offset) => {
        stmts.push(
          "(local.get $$string_class)",
          ...codeGenExpr(content, env),
          `(i32.store offset=${offset * 4})`
        );
      });
      stmts.push("(local.get $$string_class)");
      return stmts;
    }
    default:
      unhandledTag(expr);
  }
}

function allocateStringMemory(string_val: string): Array<string> {
  const stmts = [];
  var i = 1;
  //Storing the length of the string at the beginning
  stmts.push(
    ...[
      `(i32.load (i32.const 0))`, // Load the dynamic heap head offset
      `(i32.const ${string_val.length - 1})`, // Store ASCII value for 0 (end of string)
      "(i32.store)", // Store the ASCII value 0 in the new address
    ]
  );
  while (i != string_val.length + 1) {
    const char_ascii = string_val.charCodeAt(i - 1);
    stmts.push(
      ...[
        `(i32.load (i32.const 0))`, // Load the dynamic heap head offset
        `(i32.add (i32.const ${i * 4}))`, // Calc string index offset from heap offset
        `(i32.const ${char_ascii})`, // Store the ASCII value of the string index
        "(i32.store)", // Store the ASCII value in the new address
      ]
    );
    i += 1;
  }
  return stmts.concat([
    "(i32.load (i32.const 0))", // Get address for the first character of the string
    "(i32.const 0)", // Address for our upcoming store instruction
    "(i32.load (i32.const 0))", // Load the dynamic heap head offset
    `(i32.add (i32.const ${(string_val.length + 1) * 4}))`, // Move heap head beyond the string length + 1(len at beginning)
    "(i32.store)", // Save the new heap offset
  ]);
}

function codeGenLiteral(literal: Literal, env: GlobalEnv): Array<string> {
  switch (literal.tag) {
    case "num":
      return ["(i32.const " + literal.value + ")"];
    case "string":
      return allocateStringMemory(literal.value);
    case "bool":
      return [`(i32.const ${Number(literal.value)})`];
    case "none":
      return [`(i32.const 0)`];
    default:
      unhandledTag(literal);
  }
}

function codeGenBinOp(op: BinOp): string {
  switch (op) {
    case BinOp.Plus:
      return "(i32.add)";
    case BinOp.Minus:
      return "(i32.sub)";
    case BinOp.Mul:
      return "(i32.mul)";
    case BinOp.IDiv:
      return "(i32.div_s)";
    case BinOp.Mod:
      return "(i32.rem_s)";
    case BinOp.Eq:
      return "(i32.eq)";
    case BinOp.Neq:
      return "(i32.ne)";
    case BinOp.Lte:
      return "(i32.le_s)";
    case BinOp.Gte:
      return "(i32.ge_s)";
    case BinOp.Lt:
      return "(i32.lt_s)";
    case BinOp.Gt:
      return "(i32.gt_s)";
    case BinOp.Is:
      return "(i32.eq)";
    case BinOp.And:
      return "(i32.and)";
    case BinOp.Or:
      return "(i32.or)";
  }
}
