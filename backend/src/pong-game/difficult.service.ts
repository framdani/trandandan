import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { UsersService } from 'src/players/players.service';
import { UserStatus } from 'src/players/player_status.enum';
import { PlayGroundInterface } from './interfaces';
import { PongGameService } from './pong-game.service';
import { PlayGround } from './utils';

@Injectable()
export class DifficultService {
  readonly logger = new Logger('Difficult PongGame Service: ');
  readonly emptyPlayground = new PlayGround(0, 0, 800, 600, 'green', 9, true);
  constructor(private pongGameService: PongGameService, private usersService: UsersService) {}

  handleGetBackGround(playground: PlayGround): PlayGroundInterface {
    return playground.getPlayGroundInterface();
  }

  handleUserConnected(client: Socket, players: Socket[], wss: Server): void {
    // if the connected is a player add him to list of players
    if (client.handshake.query.role === 'player') {
      this.handlePlayerConnected(client, players, wss);
    } else if (client.handshake.query.role === 'spectator') {
      this.handleSpectatorConnected(client);
    }
  }

  // function handles when Spectator is connected to the difficult gateway
  async handleSpectatorConnected(client: Socket): Promise<void> {
    const { gamesRooms } = await this.pongGameService.getRooms();
    const roomname = client.handshake.query.roomname;
    const found = gamesRooms.find(room => room.roomname == roomname);
    if (found) {
      client.join(roomname);
    } else {
      client.emit('roomnotfound', {
        message: 'No such a Room',
      });
    }
  }

  // function handles when player is connected to the difficult gateway
  async handlePlayerConnected(
    client: Socket,
    players: Socket[],
    wss: Server,
  ): Promise<void> {
    const user = await this.usersService.verifyToken(client.handshake.query.accessToken as string);
    client.data.user = user;
    const found = await this.usersService.findPlayer(user.id);
    if (found && found.status === UserStatus.PLAYING) {
      client.emit('alreadyInGame', {
        player: user.username,
        message: 'You Are Already in a Game',
      });
    }
    else {
      players.push(client);
      await this.usersService.updateStatus(user.id, UserStatus.PLAYING);
      // if no one is waiting, keep him waiting
      if (players.length === 1) {
        client.data.side = 'left';
        client.data.role = 'player';
        client.emit('WaitingForPlayer', {
          player: user.username,
          message: 'Waiting For Second Player',
          playground: this.emptyPlayground.getPlayGroundInterface(),
        });
      } else {
        // if another player is waiting  Start the game
        client.data.side = 'right';
        client.data.role = 'player';
        const second = players.pop();
        const first = players.pop();

        // function to add two players to a game
        this.joinPlayersToGame(first, second, wss);
      }
    }
  }

  joinPlayersToGame(first: Socket, second: Socket, wss: Server) {
    const roomname = first.id + '+' + second.id;

        // join players to room
        first.join(roomname);
        second.join(roomname);
        first.data.roomname = roomname;
        second.data.roomname = roomname;

        // set up opponent for both players
        first.data.opponentId = second.data.user.id;
        second.data.opponentId = first.data.user.id;

        // push room to database
        this.pongGameService.addRoom({
          roomname, difficulty: 'difficult', player1: first.data.user.username as string,
          player2: second.data.user.username as string
        });

        // create a playground for players
        const playground = new PlayGround(0, 0, 800, 600, 'green', 9, true);
        first.data.playground = playground;
        second.data.playground = playground;
        this.logger.log('Starting Game in Room: ' + roomname + ' between: ' + first.data.user.username + ' & '+ second.data.user.username);
        const timer = setInterval(() => {
          if (playground.update(/* roomname, wss */) == false) {

            // get interface to send to frontend
            const pgi = this.handleGetBackGround(playground);

            // broadcast game to players in room
            wss
              .to(roomname)
              .emit('updatePlayground', { name: roomname, playground: pgi });
          } else {

            // game finished
            clearInterval(timer);
            clearInterval(first.data.gameInterval);
            this.logger.log('Game in Room: ' + roomname + ' between: ', first.data.user.username + ' & ' + second.data.user.username + ' Finished');
            if (playground.scoreBoard.playerOneScore > playground.scoreBoard.playerTwoScore) {
              this.usersService.updateLevel(first.data.user.id);
              this.usersService.winsGame(first.data.user.id);
              this.usersService.LostGame(second.data.user.id);
            } else {
              this.usersService.updateLevel(second.data.user.id);
              this.usersService.winsGame(second.data.user.id);
              this.usersService.LostGame(first.data.user.id);
            }

            // delete room from database
            this.pongGameService.deleteRoom(first.data.roomname);
          }
        }, (1.0 / 60) * 1000);
        first.data.gameInterval = timer;
        second.data.gameInterval = timer;
  }

  async handleUserDisconnected(wss: Server, client: Socket) {
    if (client.handshake.query.role === 'player' && client.data.gameInterval) {
      if (client.data.gameInterval._destroyed === false) {
        client.data.playground.ball.reset(
          client.data.playground.width / 2,
          client.data.playground.height / 2,
        );
        client.data.playground.leftPaddle.reset();
        client.data.playground.rightPaddle.reset();
        wss.to(client.data.roomname).emit('gameInterrupted', {
          playground: this.handleGetBackGround(client.data.playground),
        });
        // clearInterval if not destroyed
        clearInterval(client.data.gameInterval);
        this.logger.log('Game Interval Cleared');

        // Update Level and wins and loses for both players
        console.log(client.data.opponentId);
        await this.usersService.updateLevel(client.data.opponentId);
        await this.usersService.winsGame(client.data.opponentId);
        await this.usersService.LostGame(client.data.user.id);
        // delete room from database
        await this.pongGameService.deleteRoom(client.data.roomname);
        this.logger.log('Game in Room: ' + client.data.roomname + ' Finished');
      }

      // client left room
      client.leave(client.data.roomname);

      // Update Status to ONLINE again
      await this.usersService.updateStatus(client.data.user.id, UserStatus.ONLINE);

    } else if (client.handshake.query.role === 'player') {
      // Update Status to ONLINE again
      await this.usersService.updateStatus(client.data.user.id, UserStatus.ONLINE);
    } else if (client.handshake.query.role === 'spectator') {
      client.leave(client.handshake.query.room as string);
    }
  }

  handleKeyUpPressed(client: Socket): void {
    if (client.data.side === 'left') {
      client.data.playground.leftPaddleController.keyUpPressed();
    } else if (client.data.side === 'right') {
      client.data.playground.rightPaddleController.keyUpPressed();
    }
  }

  handleKeyDownPressed(client: Socket): void {
    if (client.data.side === 'left') {
      client.data.playground.leftPaddleController.keyDownPressed();
    } else if (client.data.side === 'right') {
      client.data.playground.rightPaddleController.keyDownPressed();
    }
  }

  handleKeyUpUnpressed(client: Socket): void {
    if (client.data.side === 'left') {
      client.data.playground.leftPaddleController.keyUpUnpressed();
    } else if (client.data.side === 'right') {
      client.data.playground.rightPaddleController.keyUpUnpressed();
    }
  }

  handleKeyDownUnpressed(client: Socket): void {
    if (client.data.side === 'left') {
      client.data.playground.leftPaddleController.keyDownUnpressed();
    } else if (client.data.side === 'right') {
      client.data.playground.rightPaddleController.keyDownUnpressed();
    }
  }

  handleTouchMove(client: Socket, data: { y: number }) {
    if (client.data.side === 'left') {
      client.data.playground.leftPaddle.touchMove(
        data.y,
        client.data.playground.bounds,
      );
    } else if (client.data.side === 'right') {
      client.data.playground.rightPaddle.touchMove(
        data.y,
        client.data.playground.bounds,
      );
    }
  }
}
