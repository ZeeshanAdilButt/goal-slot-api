declare module 'passport-google-oauth20' {
  import { Strategy as PassportStrategy } from 'passport';
  const Strategy: any;
  export { Strategy };
  export type VerifyCallback = (...args: any[]) => void;
  export default Strategy;
}
