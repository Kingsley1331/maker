declare module "poly-decomp" {
  interface Decomp {
    makeCCW(vertices: number[][]): void;
    removeCollinearPoints(vertices: number[][], threshold: number): void;
    removeDuplicatePoints(vertices: number[][], threshold: number): void;
    quickDecomp(vertices: number[][]): number[][][];
  }

  const decomp: Decomp;
  export default decomp;
}
