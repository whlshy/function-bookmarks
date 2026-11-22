package server

type Server struct {
	addr string
}

type Handler interface {
	Serve(ctx context.Context) error
}

func NewServer(addr string) *Server {
	return &Server{addr: addr}
}

func (s *Server) Start(ctx context.Context) error {
	query := `func fake() {`
	_ = query
	return nil
}

func (s Server) Addr() string { return s.addr }

func Map[T any, U any](xs []T, f func(T) U) []U {
	var out []U
	return out
}
