import { AsyncOperationManager, PromiseResolver } from '@yume-chan/async';
import { AutoDisposable, EventEmitter } from '@yume-chan/event';
import { AdbCommand, calculateChecksum, type AdbPacketData, type AdbPacketInit } from '../packet.js';
import { AbortController, WritableStream, WritableStreamDefaultWriter, type ReadableWritablePair } from '../stream/index.js';
import { decodeUtf8, encodeUtf8 } from '../utils/index.js';
import { AdbSocket, AdbSocketController } from './socket.js';

export interface AdbIncomingSocketEventArgs {
    handled: boolean;

    packet: AdbPacketData;

    serviceString: string;

    socket: AdbSocket;
}

const EmptyUint8Array = new Uint8Array(0);

export interface AdbPacketDispatcherOptions {
    calculateChecksum: boolean;
    /**
     * Before Android 9.0, ADB uses `char*` to parse service string,
     * thus requires a null character to terminate.
     *
     * Usually it should have the same value as `calculateChecksum`.
     */
    appendNullToServiceString: boolean;
    maxPayloadSize: number;
}

export class AdbPacketDispatcher extends AutoDisposable {
    // ADB socket id starts from 1
    // (0 means open failed)
    private readonly initializers = new AsyncOperationManager(1);
    private readonly sockets = new Map<number, AdbSocketController>();

    private _writer!: WritableStreamDefaultWriter<AdbPacketInit>;

    public readonly options: AdbPacketDispatcherOptions;

    private _disconnected = new PromiseResolver<void>();
    public get disconnected() { return this._disconnected.promise; }

    private readonly incomingSocketEvent = this.addDisposable(new EventEmitter<AdbIncomingSocketEventArgs>());
    public get onIncomingSocket() { return this.incomingSocketEvent.event; }

    private readonly errorEvent = this.addDisposable(new EventEmitter<Error>());
    public get onError() { return this.errorEvent.event; }

    private _abortController = new AbortController();

    public constructor(
        connection: ReadableWritablePair<AdbPacketData, AdbPacketInit>,
        options: AdbPacketDispatcherOptions
    ) {
        super();

        this.options = options;

        connection.readable
            .pipeTo(new WritableStream({
                write: async (packet) => {
                    try {
                        switch (packet.command) {
                            case AdbCommand.OK:
                                this.handleOk(packet);
                                return;
                            case AdbCommand.Close:
                                await this.handleClose(packet);
                                return;
                            case AdbCommand.Write:
                                if (this.sockets.has(packet.arg1)) {
                                    await this.sockets.get(packet.arg1)!.enqueue(packet.payload);
                                    await this.sendPacket(AdbCommand.OK, packet.arg1, packet.arg0);
                                }

                                // Maybe the device is responding to a packet of last connection
                                // Just ignore it
                                return;
                            case AdbCommand.Open:
                                await this.handleOpen(packet);
                                return;
                        }
                    } catch (e) {
                        this.errorEvent.fire(e as Error);

                        // Throw error here will stop the pipe
                        // But won't close `readable` because of `preventCancel: true`
                        throw e;
                    }
                },
            }), {
                preventCancel: false,
                signal: this._abortController.signal,
            })
            .then(() => {
                this.dispose();
            }, () => {
                // TODO: AdbPacketDispatcher: reject `_disconnected` when pipe errored?
                this.dispose();
            });

        this._writer = connection.writable.getWriter();
    }

    private handleOk(packet: AdbPacketData) {
        if (this.initializers.resolve(packet.arg1, packet.arg0)) {
            // Device successfully created the socket
            return;
        }

        const socket = this.sockets.get(packet.arg1);
        if (socket) {
            // Device has received last `WRTE` to the socket
            socket.ack();
            return;
        }

        // Maybe the device is responding to a packet of last connection
        // Tell the device to close the socket
        this.sendPacket(AdbCommand.Close, packet.arg1, packet.arg0);
    }

    private async handleClose(packet: AdbPacketData) {
        // From https://android.googlesource.com/platform/packages/modules/adb/+/65d18e2c1cc48b585811954892311b28a4c3d188/adb.cpp#459
        /* According to protocol.txt, p->msg.arg0 might be 0 to indicate
         * a failed OPEN only. However, due to a bug in previous ADB
         * versions, CLOSE(0, remote-id, "") was also used for normal
         * CLOSE() operations.
         */

        // So don't return if `reject` didn't find a pending socket
        if (packet.arg0 === 0 &&
            this.initializers.reject(packet.arg1, new Error('Socket open failed'))) {
            // Device failed to create the socket
            return;
        }

        const socket = this.sockets.get(packet.arg1);
        if (socket) {
            // The device want to close the socket
            if (!socket.closed) {
                await this.sendPacket(AdbCommand.Close, packet.arg1, packet.arg0);
            }
            socket.dispose();
            this.sockets.delete(packet.arg1);
            return;
        }

        // Maybe the device is responding to a packet of last connection
        // Just ignore it
    }

    private async handleOpen(packet: AdbPacketData) {
        // AsyncOperationManager doesn't support get and skip an ID
        // Use `add` + `resolve` to simulate this behavior
        const [localId] = this.initializers.add<number>();
        this.initializers.resolve(localId, undefined);

        const remoteId = packet.arg0;
        const serviceString = decodeUtf8(packet.payload);

        const controller = new AdbSocketController({
            dispatcher: this,
            localId,
            remoteId,
            localCreated: false,
            serviceString,
        });

        const args: AdbIncomingSocketEventArgs = {
            handled: false,
            packet,
            serviceString,
            socket: controller.socket,
        };
        this.incomingSocketEvent.fire(args);

        if (args.handled) {
            this.sockets.set(localId, controller);
            await this.sendPacket(AdbCommand.OK, localId, remoteId);
        } else {
            await this.sendPacket(AdbCommand.Close, 0, remoteId);
        }
    }

    public async createSocket(serviceString: string): Promise<AdbSocket> {
        if (this.options.appendNullToServiceString) {
            serviceString += '\0';
        }

        const [localId, initializer] = this.initializers.add<number>();
        await this.sendPacket(
            AdbCommand.Open,
            localId,
            0,
            serviceString
        );

        // Fulfilled by `handleOk`
        const remoteId = await initializer;
        const controller = new AdbSocketController({
            dispatcher: this,
            localId,
            remoteId,
            localCreated: true,
            serviceString,
        });
        this.sockets.set(localId, controller);

        return controller.socket;
    }

    public sendPacket(packet: AdbPacketInit): Promise<void>;
    public sendPacket(
        command: AdbCommand,
        arg0: number,
        arg1: number,
        payload?: string | Uint8Array
    ): Promise<void>;
    public async sendPacket(
        packetOrCommand: AdbPacketInit | AdbCommand,
        arg0?: number,
        arg1?: number,
        payload: string | Uint8Array = EmptyUint8Array,
    ): Promise<void> {
        let init: AdbPacketData;
        if (arg0 === undefined) {
            init = packetOrCommand as AdbPacketInit;
        } else {
            if (typeof payload === 'string') {
                payload = encodeUtf8(payload);
            }

            init = {
                command: packetOrCommand as AdbCommand,
                arg0: arg0 as number,
                arg1: arg1 as number,
                payload,
            };
        }

        if (init.payload &&
            init.payload.byteLength > this.options.maxPayloadSize) {
            throw new Error('payload too large');
        }

        if (this.options.calculateChecksum) {
            calculateChecksum(init);
        } else {
            (init as AdbPacketInit).checksum = 0;
        }

        await this._writer.write(init as AdbPacketInit);
    }

    public override dispose() {
        for (const socket of this.sockets.values()) {
            socket.dispose();
        }
        this.sockets.clear();

        try {
            // Stop pipes
            this._abortController.abort();
        } catch { }

        this._writer.releaseLock();

        this._disconnected.resolve();

        super.dispose();
    }
}
