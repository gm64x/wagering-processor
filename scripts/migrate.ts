import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

/** bun run migrate:up | migrate:down (reverte a última) */
const direction = process.argv[2] ?? 'up';
const orm = await MikroORM.init(config);
const migrator = orm.getMigrator();
try {
  if (direction === 'down') {
    const done = await migrator.down();
    console.log(JSON.stringify({ msg: 'migrations reverted', migrations: done.map((m) => m.name) }));
  } else {
    const done = await migrator.up();
    console.log(JSON.stringify({ msg: 'migrations applied', migrations: done.map((m) => m.name) }));
  }
} finally {
  await orm.close(true);
}
