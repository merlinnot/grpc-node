/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { ChannelOptions, channelOptionsEqual } from './channel-options';
import { Subchannel } from './subchannel';
import { ChannelCredentials } from './channel-credentials';

// 10 seconds in milliseconds. This value is arbitrary.
/**
 * The amount of time in between checks for dropping subchannels that have no
 * other references
 */
const REF_CHECK_INTERVAL = 10_000;

export class SubchannelPool {
  private pool: {
    [channelTarget: string]: {
      [subchannelTarget: string]: Array<{
        channelArguments: ChannelOptions;
        channelCredentials: ChannelCredentials;
        subchannel: Subchannel;
      }>;
    };
  } = Object.create(null);

  /**
   * A timer of a task performing a periodic subchannel cleanup.
   */
  private cleanupTimer: NodeJS.Timer | null = null;

  /**
   * A pool of subchannels use for making connections. Subchannels with the
   * exact same parameters will be reused.
   * @param global If true, this is the global subchannel pool. Otherwise, it
   * is the pool for a single channel.
   */
  constructor(private global: boolean) {}

  /**
   * Unrefs all unused subchannels and cancels the cleanup task if all
   * subchannels have been unrefed.
   */
  unrefUnusedSubchannels(): void {
    let allSubchannelsUnrefed = true;

    /* These objects are created with Object.create(null), so they do not
     * have a prototype, which means that for (... in ...) loops over them
     * do not need to be filtered */
    // tslint:disable-next-line:forin
    for (const channelTarget in this.pool) {
      // tslint:disable-next-line:forin
      for (const subchannelTarget in this.pool[channelTarget]) {
        const subchannelObjArray = this.pool[channelTarget][
          subchannelTarget
        ];

        const refedSubchannels = subchannelObjArray
          .filter(value => !value.subchannel.unrefIfOneRef());

        if (refedSubchannels.length > 0) {
          allSubchannelsUnrefed = false;
        }

        /* For each subchannel in the pool, try to unref it if it has
         * exactly one ref (which is the ref from the pool itself). If that
         * does happen, remove the subchannel from the pool */
        this.pool[channelTarget][subchannelTarget] = refedSubchannels;
      }
    }
    /* Currently we do not delete keys with empty values. If that results
     * in significant memory usage we should change it. */

    // Cancel the cleanup task if all subchannels have been unrefed.
    if (allSubchannelsUnrefed && this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Ensures that the cleanup task is spawned.
   */
  ensureCleanupTask(): void {
    if (this.global && this.cleanupTimer === null) {
      this.cleanupTimer = setInterval(() => {
        this.unrefUnusedSubchannels();
      }, REF_CHECK_INTERVAL);

      // Unref because this timer should not keep the event loop running.
      this.cleanupTimer.unref();
    }
  }

  /**
   * Get a subchannel if one already exists with exactly matching parameters.
   * Otherwise, create and save a subchannel with those parameters.
   * @param channelTarget
   * @param subchannelTarget
   * @param channelArguments
   * @param channelCredentials
   */
  getOrCreateSubchannel(
    channelTarget: string,
    subchannelTarget: string,
    channelArguments: ChannelOptions,
    channelCredentials: ChannelCredentials
  ): Subchannel {
    this.ensureCleanupTask();

    if (channelTarget in this.pool) {
      if (subchannelTarget in this.pool[channelTarget]) {
        const subchannelObjArray = this.pool[channelTarget][subchannelTarget];
        for (const subchannelObj of subchannelObjArray) {
          if (
            channelOptionsEqual(
              channelArguments,
              subchannelObj.channelArguments
            ) &&
            channelCredentials._equals(subchannelObj.channelCredentials)
          ) {
            return subchannelObj.subchannel;
          }
        }
      }
    }
    // If we get here, no matching subchannel was found
    const subchannel = new Subchannel(
      channelTarget,
      subchannelTarget,
      channelArguments,
      channelCredentials
    );
    if (!(channelTarget in this.pool)) {
      this.pool[channelTarget] = Object.create(null);
    }
    if (!(subchannelTarget in this.pool[channelTarget])) {
      this.pool[channelTarget][subchannelTarget] = [];
    }
    this.pool[channelTarget][subchannelTarget].push({
      channelArguments,
      channelCredentials,
      subchannel,
    });
    if (this.global) {
      subchannel.ref();
    }
    return subchannel;
  }
}

const globalSubchannelPool = new SubchannelPool(true);

/**
 * Get either the global subchannel pool, or a new subchannel pool.
 * @param global
 */
export function getSubchannelPool(global: boolean): SubchannelPool {
  if (global) {
    return globalSubchannelPool;
  } else {
    return new SubchannelPool(false);
  }
}
