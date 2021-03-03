describe("Frontend Tests", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  it("Sample Test", () => {
    console.log("Running sample test");
    cy.get('textarea[id="user-code"]').type("x:int = 0\nx");
    cy.get('button[id="run"]').click();
  });
});
