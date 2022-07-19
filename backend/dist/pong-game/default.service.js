"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultService = void 0;
const common_1 = require("@nestjs/common");
const players_service_1 = require("../players/players.service");
const player_status_enum_1 = require("../players/player_status.enum");
const pong_game_service_1 = require("./pong-game.service");
const utils_1 = require("./utils");
let DefaultService = class DefaultService {
    constructor(pongGameService, usersService) {
        this.pongGameService = pongGameService;
        this.usersService = usersService;
        this.logger = new common_1.Logger('Default PongGame Service: ');
        this.emptyPlayground = new utils_1.PlayGround(0, 0, 800, 600, 'black', 9, false);
    }
    handleGetBackGround(playground) {
        return playground.getPlayGroundInterface();
    }
    handleUserConnected(client, players, wss) {
        if (client.handshake.query.role === 'player') {
            this.handlePlayerConnected(client, players, wss);
        }
        else if (client.handshake.query.role === 'spectator') {
            this.handleSpectatorConnected(client);
        }
    }
    async handleSpectatorConnected(client) {
        const { rooms } = await this.pongGameService.getRooms();
        const roomname = client.handshake.query.roomname;
        const found = rooms.find(room => room.roomname == roomname);
        if (found) {
            client.join(roomname);
        }
        else {
            client.emit('roomnotfound', {
                message: 'No such a Room',
            });
        }
    }
    async handlePlayerConnected(client, players, wss) {
        const user = await this.usersService.verifyToken(client.handshake.query.accessToken);
        client.data.user = user;
        const found = await this.usersService.findOrCreate(user.id, user.username);
        if (found.status === player_status_enum_1.UserStatus.PLAYING) {
            client.emit('alreadyInGame', {
                player: user.username,
                message: 'You Are Already in a Game',
            });
        }
        else {
            players.push(client);
            await this.usersService.updateStatus(user.id, player_status_enum_1.UserStatus.PLAYING);
            if (players.length === 1) {
                client.data.side = 'left';
                client.data.role = 'player';
                client.emit('WaitingForPlayer', {
                    player: user.username,
                    message: 'Waiting For Second Player',
                    playground: this.emptyPlayground.getPlayGroundInterface(),
                });
            }
            else {
                client.data.side = 'right';
                client.data.role = 'player';
                const second = players.pop();
                const first = players.pop();
                this.joinPlayersToGame(first, second, wss);
            }
        }
    }
    joinPlayersToGame(first, second, wss) {
        const roomname = first.id + '+' + second.id;
        first.join(roomname);
        second.join(roomname);
        first.data.roomname = roomname;
        second.data.roomname = roomname;
        first.data.opponentId = second.data.user.id;
        second.data.opponentId = first.data.user.id;
        this.pongGameService.addRoom({
            roomname, difficulty: 'default', player1: first.data.user.username,
            player2: second.data.user.username
        });
        const playground = new utils_1.PlayGround(0, 0, 800, 600, 'black', 9, false);
        first.data.playground = playground;
        second.data.playground = playground;
        const timer = setInterval(() => {
            if (playground.update() == false) {
                const pgi = this.handleGetBackGround(playground);
                wss
                    .to(roomname)
                    .emit('updatePlayground', { name: roomname, playground: pgi });
            }
            else {
                clearInterval(timer);
                clearInterval(first.data.gameInterval);
                this.logger.log('Game in room ' + roomname + ' Finished');
                if (playground.scoreBoard.playerOneScore > playground.scoreBoard.playerTwoScore) {
                    this.usersService.updateLevel(first.data.user.id);
                    this.usersService.winsGame(first.data.user.id);
                    this.usersService.LostGame(second.data.user.id);
                }
                else {
                    this.usersService.updateLevel(second.data.user.id);
                    this.usersService.winsGame(second.data.user.id);
                    this.usersService.LostGame(first.data.user.id);
                }
                this.pongGameService.deleteRoom(first.data.roomname);
            }
        }, (1.0 / 60) * 1000);
        first.data.gameInterval = timer;
        second.data.gameInterval = timer;
    }
    async handleUserDisconnected(wss, client) {
        if (client.handshake.query.role === 'player' && client.data.gameInterval) {
            client.data.playground.ball.reset(client.data.playground.width / 2, client.data.playground.height / 2);
            client.data.playground.leftPaddle.reset();
            client.data.playground.rightPaddle.reset();
            wss.to(client.data.roomname).emit('gameInterrupted', {
                playground: this.handleGetBackGround(client.data.playground),
            });
            client.leave(client.data.roomname);
            clearInterval(client.data.gameInterval);
            await this.usersService.updateStatus(client.data.user.id, player_status_enum_1.UserStatus.ONLINE);
            this.usersService.updateLevel(client.data.opponentId);
            this.usersService.winsGame(client.data.opponentId);
            this.usersService.LostGame(client.data.user.id);
            await this.pongGameService.deleteRoom(client.data.roomname);
            this.logger.log('Game Interval Cleared');
        }
        else if (client.handshake.query.role === 'player') {
            await this.usersService.updateStatus(client.data.user.id, player_status_enum_1.UserStatus.ONLINE);
        }
        else if (client.handshake.query.role === 'spectator') {
            client.leave(client.handshake.query.room);
        }
    }
    handleKeyUpPressed(client) {
        if (client.data.side === 'left') {
            client.data.playground.leftPaddleController.keyUpPressed();
        }
        else if (client.data.side === 'right') {
            client.data.playground.rightPaddleController.keyUpPressed();
        }
    }
    handleKeyDownPressed(client) {
        if (client.data.side === 'left') {
            client.data.playground.leftPaddleController.keyDownPressed();
        }
        else if (client.data.side === 'right') {
            client.data.playground.rightPaddleController.keyDownPressed();
        }
    }
    handleKeyUpUnpressed(client) {
        if (client.data.side === 'left') {
            client.data.playground.leftPaddleController.keyUpUnpressed();
        }
        else if (client.data.side === 'right') {
            client.data.playground.rightPaddleController.keyUpUnpressed();
        }
    }
    handleKeyDownUnpressed(client) {
        if (client.data.side === 'left') {
            client.data.playground.leftPaddleController.keyDownUnpressed();
        }
        else if (client.data.side === 'right') {
            client.data.playground.rightPaddleController.keyDownUnpressed();
        }
    }
    handleTouchMove(client, data) {
        if (client.data.side === 'left') {
            client.data.playground.leftPaddle.touchMove(data.y, client.data.playground.bounds);
        }
        else if (client.data.side === 'right') {
            client.data.playground.rightPaddle.touchMove(data.y, client.data.playground.bounds);
        }
    }
};
DefaultService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [pong_game_service_1.PongGameService, players_service_1.UsersService])
], DefaultService);
exports.DefaultService = DefaultService;
//# sourceMappingURL=default.service.js.map