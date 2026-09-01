import { describe, expect, test } from 'bun:test'
import { PublishError } from '../src/errors.js'
import { createImmutablePublishTransaction } from '../src/transaction.js'

const artifact = {
  modules: ['AQID'],
  dependencies: ['0x1'],
}

async function commandsFor(count: number): Promise<Record<string, unknown>[]> {
  const transaction = createImmutablePublishTransaction(Array.from({ length: count }, () => artifact))
  const serialized = JSON.parse(await transaction.toJSON()) as {
    sender: string | null
    gasData: Record<string, unknown>
    commands: Record<string, unknown>[]
  }
  expect(serialized.sender).toBeNull()
  expect(serialized.gasData).toEqual({ budget: null, price: null, owner: null, payment: null })
  return serialized.commands
}

describe('createImmutablePublishTransaction', () => {
  test('rejects the exact zero-package boundary without applying anything', () => {
    expect(() => createImmutablePublishTransaction([])).toThrow(PublishError)
    try {
      createImmutablePublishTransaction([])
    } catch (error) {
      expect(error).toMatchObject({ code: 'EMPTY_BATCH', effect: 'not_applied' })
    }
  })

  test('composes one atomic publish and immutable-cap consumption', async () => {
    const commands = await commandsFor(1)
    expect(commands).toHaveLength(2)
    expect(commands[0]).toHaveProperty('Publish')
    expect(commands[1]).toMatchObject({
      MoveCall: {
        package: `0x${'0'.repeat(63)}2`,
        module: 'package',
        function: 'make_immutable',
        arguments: [{ NestedResult: [0, 0] }],
      },
    })
  })

  test('composes the exact five-package protocol maximum', async () => {
    const commands = await commandsFor(5)
    expect(commands).toHaveLength(10)
    for (let index = 0; index < 5; index += 1) {
      expect(commands[index * 2]).toHaveProperty('Publish')
      expect(commands[index * 2 + 1]).toMatchObject({
        MoveCall: {
          function: 'make_immutable',
          arguments: [{ NestedResult: [index * 2, 0] }],
        },
      })
    }
  })

  test('rejects the exact six-package boundary without creating a transaction', () => {
    try {
      createImmutablePublishTransaction(Array.from({ length: 6 }, () => artifact))
      throw new Error('expected batch limit rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError)
      expect(error).toMatchObject({ code: 'PUBLISH_BATCH_LIMIT', effect: 'not_applied' })
    }
  })
})
