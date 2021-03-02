 import * as mocha from 'mocha';
 import {expect} from 'chai';
 import { parser } from 'lezer-python';
 import { traverseExpr, traverseStmt, traverse, parse, traverseVarInit } from '../parser';

 describe('parse(source) function', () => {
   it('parse a typed dict variable initialization', () => {
     const parsed = parse("d:[int, bool] = None");
     expect(parsed.inits).to.deep.equal([{
                                          name: "d",
                                          type: {
                                                 tag:"dict",
                                                 key: {tag:"number"},
                                                 value: {tag:"bool"}
                                                 }, //end of type
                                          value: {tag:"none"}
                                          }]);
   });  

   it('parse an empty dict expression', () => {
     const parsed = parse("d = {}");
     expect(parsed.stmts).to.deep.equal([{
                                          tag: "assign",
                                          name: "d",
                                          value: {
                                                  tag: "dict",
                                                  entries: []
                                                  } // end of values
                                          }]);
   });  
   
   it('parse a dict expression', () => {
     const parsed = parse("d = {2:True}");
     expect(parsed.stmts).to.deep.equal([{
                                          tag: "assign",
                                          name: "d",
                                          value: {
                                                  tag: "dict",
                                                  entries: [[{tag:"literal", value: {tag: "num", value: 2n}},
                                                             {tag:"literal", value: {tag: "bool", value: true}}
                                                            ]]
                                                  } // end of values
                                          }]);
   });  
   
   it('parse a bracket-lookup expression', () => {
     const parsed = parse("x = d[2]");
     expect(parsed.stmts).to.deep.equal([{
                                          tag: "assign",
                                          name: "x",
                                          value: {
                                                  tag: "bracket-lookup",
                                                  obj: {tag: "id", name: "d"},
                                                  key: {tag:"literal", value: {tag: "num", value: 2n}}
                                                  } // end of values
                                          }]);
   });  
});

