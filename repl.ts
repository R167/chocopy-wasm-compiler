import { run, Config } from "./runner";
import { GlobalEnv } from "./compiler";
import { tc, defaultTypeEnv, GlobalTypeEnv } from "./type-check";
import { Value, Type } from "./ast";
import { parse } from "./parser";
import { bignumfunctions } from "./bignumfunctions";
import { NUM, BOOL, NONE, PyValue, PyBigInt, encodeValue } from "./utils";
import { ArithmeticError, ZeroDivisionError } from "./error";

interface REPL {
  run(source: string): Promise<any>;
}

export class BasicREPL {
  currentEnv: GlobalEnv;
  currentTypeEnv: GlobalTypeEnv;
  functions: string;
  importObject: any;
  memory: any;
  constructor(importObject: any) {
    this.importObject = importObject;
    if (!importObject.js) {
      const memory = new WebAssembly.Memory({ initial: 2000, maximum: 2000 });
      const view = new Int32Array(memory.buffer);
      view[0] = 4;
      this.importObject.js = { memory: memory };
    }
    this.currentEnv = {
      globals: new Map(),
      classes: new Map(),
      locals: new Set(),
      offset: 1,
    };
    this.importObject.imports.__internal_print = (arg: any) => {
      console.log("Logging from WASM: ", arg);
      this.importObject.imports.print(
        PyValue(NUM, arg, new Uint32Array(this.importObject.js.memory.buffer))
      );
      return arg;
    };
    this.importObject.imports.__internal_print_num = (arg: number) => {
      console.log("Logging from WASM: ", arg);
      this.importObject.imports.print(
        PyValue(NUM, arg, new Uint32Array(this.importObject.js.memory.buffer))
      );
      return arg;
    };
    this.importObject.imports.__internal_print_bool = (arg: number) => {
      console.log("Logging from WASM: ", arg);
      this.importObject.imports.print(PyValue(BOOL, arg, null));
      return arg;
    };
    this.importObject.imports.__internal_print_none = (arg: number) => {
      console.log("Logging from WASM: ", arg);
      this.importObject.imports.print(PyValue(NONE, arg, null));
      return arg;
    };
    this.importObject.imports.abs = (arg: number) => {
      var mem = new Uint32Array(this.importObject.js.memory.buffer);
      var val = PyValue(NUM, arg, mem);
      if (val.tag !== "num") {
        throw new ArithmeticError("Abs operation failed at runtime");
      }
      return encodeValue(PyBigInt(val.value < 0 ? -val.value : val.value), mem);
    };
    this.importObject.imports.pow = (base: number, exp: number) => {
      var mem = new Uint32Array(this.importObject.js.memory.buffer);
      var baseVal = PyValue(NUM, base, mem);
      var expVal = PyValue(NUM, exp, mem);
      if (baseVal.tag == "num" && expVal.tag == "num") {
        // Javascript does not allow a negative BigInt exponent.
        if (expVal.value < 1) {
          return encodeValue(PyBigInt(0n), mem);
        } else {
          return encodeValue(PyBigInt(baseVal.value ** expVal.value), mem);
        }
      }
      throw new ArithmeticError("binary operation failed at runtime");
    };
    this.importObject.imports.max = (x: number, y: number) => {
      var mem = new Uint32Array(this.importObject.js.memory.buffer);
      var xval = PyValue(NUM, x, mem);
      var yval = PyValue(NUM, y, mem);
      if (xval.tag == "num" && yval.tag == "num") {
        var res = xval.value > yval.value ? xval.value : yval.value;
        return encodeValue(PyBigInt(res), mem);
      }
      throw new ArithmeticError("binary operation failed at runtime");
    };
    this.importObject.imports.min = (x: number, y: number) => {
      var mem = new Uint32Array(this.importObject.js.memory.buffer);
      var xval = PyValue(NUM, x, mem);
      var yval = PyValue(NUM, y, mem);
      if (xval.tag == "num" && yval.tag == "num") {
        var res = xval.value < yval.value ? xval.value : yval.value;
        return encodeValue(PyBigInt(res), mem);
      }
      throw new ArithmeticError("binary operation failed at runtime");
    };
    this.importObject.imports.__big_num_add = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x + y;
      });
    this.importObject.imports.__big_num_sub = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x - y;
      });
    this.importObject.imports.__big_num_mul = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x * y;
      });
    this.importObject.imports.__big_num_div = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        if (y === 0n) {
          throw new ZeroDivisionError();
        }
        return x / y;
      });
    this.importObject.imports.__big_num_mod = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x % y;
      });
    this.importObject.imports.__big_num_eq = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x === y;
      });
    this.importObject.imports.__big_num_ne = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x !== y;
      });
    this.importObject.imports.__big_num_lt = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x < y;
      });
    this.importObject.imports.__big_num_lte = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x <= y;
      });
    this.importObject.imports.__big_num_gt = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x > y;
      });
    this.importObject.imports.__big_num_gte = (x: number, y: number) =>
      this.binOpInterface(x, y, (x: bigint, y: bigint) => {
        return x >= y;
      });

    this.currentTypeEnv = defaultTypeEnv;
    this.functions = bignumfunctions;
  }
  binOpInterface(x: number, y: number, f: Function): number {
    var mem = new Uint32Array(this.importObject.js.memory.buffer);
    var xval = PyValue(NUM, x, mem);
    var yval = PyValue(NUM, y, mem);
    if (xval.tag == "num" && yval.tag == "num") {
      return encodeValue(PyBigInt(f(xval.value, yval.value)), mem);
    }
    throw new ArithmeticError("binary operation failed at runtime");
  }
  async run(source: string): Promise<Value> {
    const config: Config = {
      importObject: this.importObject,
      env: this.currentEnv,
      typeEnv: this.currentTypeEnv,
      functions: this.functions,
    };
    const [result, newEnv, newTypeEnv, newFunctions] = await run(
      source,
      config
    );
    this.currentEnv = newEnv;
    this.currentTypeEnv = newTypeEnv;
    this.functions += newFunctions;
    return result;
  }
  async tc(source: string): Promise<Type> {
    const config: Config = {
      importObject: this.importObject,
      env: this.currentEnv,
      typeEnv: this.currentTypeEnv,
      functions: this.functions,
    };
    const parsed = parse(source);
    const [result, _] = await tc(this.currentTypeEnv, parsed);
    return result.a;
  }
}
