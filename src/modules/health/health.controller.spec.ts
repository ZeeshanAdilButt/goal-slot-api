import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

// Regression cover for the unauthenticated mail-send endpoints.
//
// HealthController is the only controller with no JwtAuthGuard, and there is
// no global guard, so POST /api/health/test-email/{share-invitation,welcome,
// share-accepted} let anyone on the internet send mail from the app's own
// DKIM-signed sender, with attacker-controlled inviterName and inviteToken
// interpolated raw into the HTML body. Swagger published them too.

function routeHandlers(controller: any): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      Reflect.hasMetadata(PATH_METADATA, controller.prototype[name]),
  );
}

describe('HealthController surface', () => {
  it('exposes only the two GET probes', () => {
    const handlers = routeHandlers(HealthController);

    expect(handlers.sort()).toEqual(['check', 'getDetailedHealth']);
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        (HealthController.prototype as any).check,
      ),
    ).toBe(RequestMethod.GET);
  });

  it('exposes no POST route at all', () => {
    for (const name of routeHandlers(HealthController)) {
      const method = Reflect.getMetadata(
        METHOD_METADATA,
        (HealthController.prototype as any)[name],
      );
      expect(method).not.toBe(RequestMethod.POST);
    }
  });

  it('has no test-email route', () => {
    const paths = routeHandlers(HealthController).map((name) =>
      Reflect.getMetadata(
        PATH_METADATA,
        (HealthController.prototype as any)[name],
      ),
    );

    for (const path of paths) {
      expect(String(path)).not.toContain('test-email');
    }
  });

  it('cannot send mail: EmailService is not injected', () => {
    const deps: any[] =
      Reflect.getMetadata('design:paramtypes', HealthController) ?? [];

    expect(deps.map((d) => d?.name)).not.toContain('EmailService');
  });

  it('does not import EmailModule', () => {
    const imports: any[] = Reflect.getMetadata('imports', HealthModule) ?? [];

    expect(imports.map((m) => m?.name)).not.toContain('EmailModule');
  });

  it('still answers the liveness probe', () => {
    const body = new HealthController({} as any).check();

    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });
});
