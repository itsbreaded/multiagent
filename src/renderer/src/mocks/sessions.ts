import type { Session } from '../../../shared/types'

const now = new Date()
const hoursAgo = (h: number): string => new Date(now.getTime() - h * 3600_000).toISOString()
const daysAgo = (d: number): string => new Date(now.getTime() - d * 86_400_000).toISOString()

export const MOCK_SESSIONS: Session[] = [
  // 1. live-attached
  {
    sessionId: 'a1b2c3d4-0001-0001-0001-000000000001',
    cwd: 'C:\\source\\ecentria\\core',
    projectName: 'ecentria/core',
    gitBranch: 'feature/auth-token-refactor',
    firstMessage: 'can you refactor the auth module to use the new token format',
    lastMessage: 'looks good, now add the unit tests for the refresh path',
    firstActivity: daysAgo(3),
    lastActivity: hoursAgo(1),
    messageCount: 24,
    status: 'live-attached',
    pid: 14820,
    liveStatus: 'running',
  },

  // 2. live-detached
  {
    sessionId: 'a1b2c3d4-0002-0002-0002-000000000002',
    cwd: 'C:\\source\\sql_server',
    projectName: 'source/sql-server',
    gitBranch: 'main',
    firstMessage: 'add an index to the orders table on customer_id and created_at',
    lastMessage: 'what is the estimated row count for the backfill migration?',
    firstActivity: daysAgo(1),
    lastActivity: hoursAgo(3),
    messageCount: 11,
    status: 'live-detached',
    pid: 18244,
    liveStatus: 'idle',
  },

  // 3. resumable
  {
    sessionId: 'a1b2c3d4-0003-0003-0003-000000000003',
    cwd: 'C:\\source\\stoneedge-source-code',
    projectName: 'source/stoneedge-source-code',
    gitBranch: 'develop',
    firstMessage: 'add error handling to the OMTemp order sync so failed records go to a dead-letter table',
    lastMessage: 'the rollback logic looks right, ship it',
    firstActivity: daysAgo(5),
    lastActivity: daysAgo(2),
    messageCount: 18,
    status: 'resumable',
  },

  // 4. resumable
  {
    sessionId: 'a1b2c3d4-0004-0004-0004-000000000004',
    cwd: 'C:\\source\\ecentria\\core',
    projectName: 'ecentria/core',
    gitBranch: 'bugfix/checkout-502',
    firstMessage: 'investigate the 502 errors on checkout that started after the last deploy',
    lastMessage: 'found the issue: the payment gateway timeout is 5s but the SLA is 10s - bumping the env var',
    firstActivity: daysAgo(7),
    lastActivity: daysAgo(4),
    messageCount: 31,
    status: 'resumable',
  },

  // 5. resumable
  {
    sessionId: 'a1b2c3d4-0005-0005-0005-000000000005',
    cwd: 'C:\\Users\\Chris.Haniszewski\\Desktop\\MultiAgent',
    projectName: 'Chris.Haniszewski/MultiAgent',
    gitBranch: 'main',
    firstMessage: 'bootstrap the electron-vite project for the MultiAgent session manager',
    lastMessage: 'the preload bridge is set up, now wire the renderer side',
    firstActivity: daysAgo(4),
    lastActivity: daysAgo(1),
    messageCount: 9,
    status: 'resumable',
  },

  // 6. resumable
  {
    sessionId: 'a1b2c3d4-0006-0006-0006-000000000006',
    cwd: 'C:\\source\\sql_server',
    projectName: 'source/sql-server',
    gitBranch: 'feature/reporting-views',
    firstMessage: 'create a view that aggregates daily revenue by channel and product category',
    lastMessage: 'the NULL handling for returns looks off, can you check the COALESCE logic',
    firstActivity: daysAgo(10),
    lastActivity: daysAgo(6),
    messageCount: 14,
    status: 'resumable',
  },

  // 7. archived
  {
    sessionId: 'a1b2c3d4-0007-0007-0007-000000000007',
    cwd: 'C:\\source\\ecentria\\core',
    projectName: 'ecentria/core',
    gitBranch: null,
    firstMessage: 'write a spec for the new customer import pipeline',
    lastMessage: 'spec looks complete, archiving this session',
    firstActivity: daysAgo(60),
    lastActivity: daysAgo(45),
    messageCount: 7,
    status: 'archived',
  },

  // 8. archived
  {
    sessionId: 'a1b2c3d4-0008-0008-0008-000000000008',
    cwd: 'C:\\source\\stoneedge-source-code',
    projectName: 'source/stoneedge-source-code',
    gitBranch: null,
    firstMessage: 'migrate the legacy VBA order processing macros to the new COM library pattern',
    lastMessage: 'migration done and tested against ACT-AVB',
    firstActivity: daysAgo(90),
    lastActivity: daysAgo(75),
    messageCount: 42,
    status: 'archived',
  },
]
